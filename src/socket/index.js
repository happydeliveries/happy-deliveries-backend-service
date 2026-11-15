const db = require('../config/database');
const jwt = require('jsonwebtoken');

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

  // Attach authenticated user from JWT handshake when provided
  io.use((socket, next) => {
    try {
      const rawToken =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        socket.handshake.query?.token;
      if (rawToken && process.env.JWT_SECRET) {
        const decoded = jwt.verify(String(rawToken), process.env.JWT_SECRET);
        socket.user = { id: decoded.id, role: decoded.role };
      }
    } catch {
      // Allow connection (e.g. session-based manager portal) without socket.user
    }
    next();
  });
  
  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    if (socket.user?.id) {
      socket.join(`user_${socket.user.id}`);
    }

    // Drivers join the shared "drivers" room to receive newly published (paid) orders
    socket.on('join_driver_room', () => {
      if (socket.user && socket.user.role !== 'driver') return;
      socket.join('drivers');
      console.log(`Socket ${socket.id} joined drivers room`);
    });

    // Restaurant managers join this room to receive pending order notifications
    const joinManagerRoom = () => {
      if (socket.user && socket.user.role !== 'restaurant_manager') return;
      socket.join('restaurant_managers');
      console.log(`Socket ${socket.id} joined restaurant managers room`);
    };
    socket.on('join_manager_room', joinManagerRoom);
    socket.on('join_manager', joinManagerRoom);

    // Join user to their room based on user ID
    socket.on('join', (userId) => {
      const targetUserId = socket.user?.id || userId;
      if (!targetUserId) return;
      socket.join(`user_${targetUserId}`);
      console.log(`User ${targetUserId} joined their room`);
    });
    
    // Join driver to driver room
    socket.on('join_driver', (driverId) => {
      if (socket.user && socket.user.role !== 'driver') return;
      const targetDriverId = socket.user?.id || driverId;
      if (!targetDriverId) return;
      socket.join(`driver_${targetDriverId}`);
      console.log(`Driver ${targetDriverId} joined driver room`);
    });
    
    // Join order room for real-time updates
    socket.on('join_order', async (orderId) => {
      if (!orderId) return;
      if (socket.user?.id) {
        try {
          const checkRes = await db.query(
            `SELECT o.id
             FROM orders o
             LEFT JOIN customers c ON o.customer_id = c.id
             LEFT JOIN drivers d ON o.driver_id = d.id
             LEFT JOIN restaurants r ON o.restaurant_id = r.id
             LEFT JOIN restaurant_managers rm ON r.manager_id = rm.id
             WHERE o.id = $1
               AND (
                 c.user_id = $2
                 OR d.user_id = $2
                 OR rm.user_id = $2
                 OR (o.driver_id IS NULL AND $3 = 'driver')
               )
             LIMIT 1`,
            [orderId, socket.user.id, socket.user.role || '']
          );
          if (checkRes.rows.length === 0) return;
        } catch {
          // Allow fallback join if query fails during cold-start
        }
      }
      socket.join(`order_${orderId}`);
      console.log(`Client joined order room: ${orderId}`);
    });
    
    // Handle location updates from drivers
    socket.on('driver_location_update', async (data = {}) => {
      if (socket.user && socket.user.role !== 'driver') return;
      const { driverId, orderId } = data;
      const coords = extractLngLat(data);
      if (!coords) return;

      const { lng, lat } = coords;
      const effectiveDriverRef = socket.user?.id || driverId;
      const payload = {
        driverId: effectiveDriverRef,
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
        let resolvedDriverId = effectiveDriverRef;
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
      } else if (effectiveDriverRef) {
        // Broadcast to all active orders for this driver
        try {
          const activeOrders = await db.query(
            `SELECT id FROM orders
             WHERE (driver_id = $1 OR driver_id = (SELECT id FROM drivers WHERE user_id = $1 LIMIT 1))
               AND status IN ('accepted_by_driver', 'picked_up', 'on_the_way', 'arrived')`,
            [effectiveDriverRef]
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
      
      console.log(`Driver ${effectiveDriverRef} location updated for order ${orderId}: [${lng}, ${lat}]`);
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
    // Never broadcast customer delivery verification_code to the shared order room
    let safeData = { ...data };
    if (safeData.order && typeof safeData.order === 'object') {
      const { verification_code, code_expires_at, code_used_at, ...restOrder } = safeData.order;
      safeData.order = restOrder;
    }
    delete safeData.verification_code;

    ioInstance.to(`order_${orderId}`).emit('order_update', {
      ...safeData,
      orderId,
      status
    });
  }
}

function emitUserEvent(userId, eventName, data) {
  if (ioInstance && userId && eventName) {
    ioInstance.to(`user_${userId}`).emit(eventName, data);
  }
}

function emitDriverLocation(orderId, payload) {
  if (ioInstance && orderId) {
    ioInstance.to(`order_${orderId}`).emit('driver_location', payload);
  }
}

module.exports.emitOrderUpdate = emitOrderUpdate;
module.exports.emitUserEvent = emitUserEvent;
module.exports.emitDriverLocation = emitDriverLocation;