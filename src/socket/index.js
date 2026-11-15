const db = require('../config/database');

let ioInstance;

function extractLngLat(data = {}) {
  const loc = data.location;
  if (Array.isArray(loc) && loc.length >= 2) {
    const lng = Number(loc[0]);
    const lat = Number(loc[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lng, lat };
  }
  if (loc && typeof loc === 'object') {
    const lat = Number(loc.latitude ?? loc.lat ?? loc.y);
    const lng = Number(loc.longitude ?? loc.lng ?? loc.x);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lng, lat };
  }
  const lat = Number(data.latitude ?? data.lat);
  const lng = Number(data.longitude ?? data.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lng, lat };
  return null;
}

module.exports = (io) => {
  ioInstance = io; // Store the instance for the helper function
  
  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    // Join user to their room based on user ID
    socket.on('join', (userId) => {
      socket.join(`user_${userId}`);
      console.log(`User ${userId} joined their room`);
    });
    
    // Join driver to driver room
    socket.on('join_driver', (driverId) => {
      socket.join(`driver_${driverId}`);
      console.log(`Driver ${driverId} joined driver room`);
    });
    
    // Join order room for real-time updates
    socket.on('join_order', (orderId) => {
      if (orderId) {
        socket.join(`order_${orderId}`);
        console.log(`Client joined order room: ${orderId}`);
      }
    });
    
    // Handle location updates from drivers
    socket.on('driver_location_update', async (data = {}) => {
      const { driverId, orderId } = data;
      const coords = extractLngLat(data);
      if (!coords) return;

      const { lng, lat } = coords;
      const payload = {
        driverId,
        orderId,
        location: [lng, lat],
        latitude: lat,
        longitude: lng,
        heading: data.heading ?? null,
        speed: data.speed ?? null,
        timestamp: new Date().toISOString()
      };

      // Persist driver location in DB so REST fetches / refreshes also get the latest live location
      try {
        let resolvedDriverId = driverId;
        if (!resolvedDriverId && orderId) {
          const ordRes = await db.query('SELECT driver_id FROM orders WHERE id = $1', [orderId]);
          resolvedDriverId = ordRes.rows[0]?.driver_id || null;
        }
        if (resolvedDriverId) {
          await db.query(
            `UPDATE drivers
             SET current_location = point($1, $2),
                 last_location_update = NOW()
             WHERE id = $3 OR user_id = $3`,
            [lng, lat, resolvedDriverId]
          );
        }
        if (orderId && resolvedDriverId) {
          await db.query(
            `INSERT INTO delivery_tracking (order_id, driver_id, location)
             VALUES ($1, (SELECT id FROM drivers WHERE id = $2 OR user_id = $2 LIMIT 1), point($3, $4))`,
            [orderId, resolvedDriverId, lng, lat]
          ).catch(() => {});
        }
      } catch (err) {
        console.warn('Failed to persist socket driver location:', err.message);
      }

      // Broadcast to order room
      if (orderId) {
        io.to(`order_${orderId}`).emit('driver_location', payload);
      } else if (driverId) {
        // Broadcast to all active orders for this driver
        try {
          const activeOrders = await db.query(
            `SELECT id FROM orders
             WHERE (driver_id = $1 OR driver_id = (SELECT id FROM drivers WHERE user_id = $1 LIMIT 1))
               AND status IN ('accepted_by_driver', 'picked_up', 'on_the_way', 'arrived')`,
            [driverId]
          );
          for (const row of activeOrders.rows) {
            io.to(`order_${row.id}`).emit('driver_location', {
              ...payload,
              orderId: row.id
            });
          }
        } catch (err) {
          // ignore
        }
      }
      
      console.log(`Driver ${driverId} location updated for order ${orderId}: [${lng}, ${lat}]`);
    });
    
    // Handle order status updates
    socket.on('order_status_update', (data) => {
      const { orderId, status, userId } = data;
      
      // Notify customer
      if (userId) {
        io.to(`user_${userId}`).emit('order_update', {
          orderId,
          status,
          new_status: status,
          timestamp: new Date().toISOString()
        });
      }
      if (orderId) {
        io.to(`order_${orderId}`).emit('order_update', {
          orderId,
          status,
          new_status: status,
          timestamp: new Date().toISOString()
        });
      }
      
      console.log(`Order ${orderId} status updated to ${status}`);
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

};

function emitOrderUpdate(orderId, data) {
  if (ioInstance && orderId) {
    const status = data?.status || data?.new_status || data?.order?.status;
    ioInstance.to(`order_${orderId}`).emit('order_update', {
      ...data,
      orderId,
      status
    });
  }
}

function emitDriverLocation(orderId, payload) {
  if (ioInstance && orderId) {
    ioInstance.to(`order_${orderId}`).emit('driver_location', payload);
  }
}

module.exports.emitOrderUpdate = emitOrderUpdate;
module.exports.emitDriverLocation = emitDriverLocation;