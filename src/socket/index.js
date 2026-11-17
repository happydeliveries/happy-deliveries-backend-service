const db = require('../config/database');
const jwt = require('jsonwebtoken');
const {
  peekOrderCachedRoute,
  getOrderCachedRoute,
  resolveOrderRouteEndpoints,
  clearOrderRouteCache,
} = require('../utils/routing');

let ioInstance;
const LOCATION_PERSIST_INTERVAL_MS = 12000;
const ACTIVE_ORDERS_CACHE_MS = 10000;
const ORDER_ENDPOINT_CACHE_MS = 20000;
const lastDriverDbPersist = new Map();
const driverActiveOrdersCache = new Map();
const orderCustomerUserCache = new Map();
const orderEndpointsCache = new Map();
const socketRouteRefreshInFlight = new Set();

async function getCachedOrderEndpoints(orderId) {
  const key = String(orderId);
  const existing = orderEndpointsCache.get(key);
  if (existing && Date.now() - existing.cachedAt < ORDER_ENDPOINT_CACHE_MS) {
    return existing.endpoints;
  }

  const res = await db.query(
    `SELECT o.id, o.status, o.delivery_address, r.address AS restaurant_address,
            ST_X(r.location::geometry) AS r_lng, ST_Y(r.location::geometry) AS r_lat
     FROM orders o
     JOIN restaurants r ON o.restaurant_id = r.id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  );
  const row = res.rows[0];
  if (!row) return null;

  const orderObj = {
    id: row.id,
    status: row.status,
    delivery_address: row.delivery_address,
    restaurant_address: row.restaurant_address,
    restaurant_location:
      row.r_lat != null && row.r_lng != null
        ? { latitude: Number(row.r_lat), longitude: Number(row.r_lng) }
        : null,
  };
  const endpoints = await resolveOrderRouteEndpoints(orderObj);
  if (orderEndpointsCache.size > 1000) {
    const oldestKey = orderEndpointsCache.keys().next().value;
    if (oldestKey) orderEndpointsCache.delete(oldestKey);
  }
  orderEndpointsCache.set(key, { endpoints, cachedAt: Date.now() });
  return endpoints;
}

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

    // Drivers join the shared "drivers" room when online to receive available orders
    socket.on('join_driver_room', () => {
      if (socket.user && socket.user.role !== 'driver') return;
      socket.join('drivers');
      console.log(`Socket ${socket.id} joined drivers room`);
    });

    socket.on('leave_driver_room', () => {
      socket.leave('drivers');
      console.log(`Socket ${socket.id} left drivers room`);
    });

    // Restaurant managers join scoped restaurant rooms (plus global room when unscoped)
    const joinManagerRoom = async (payload) => {
      if (socket.user && socket.user.role !== 'restaurant_manager') return;

      let restaurantIds = [];
      let managerId = null;

      if (typeof payload === 'string') {
        managerId = payload;
      } else if (payload && typeof payload === 'object') {
        managerId = payload.managerId || null;
        if (Array.isArray(payload.restaurantIds)) {
          restaurantIds = payload.restaurantIds.filter(Boolean).map(String);
        }
      }

      if (socket.user?.id && socket.user.role === 'restaurant_manager') {
        socket.join(`manager_${socket.user.id}`);
        if (restaurantIds.length === 0) {
          try {
            const resRows = await db.query(
              `SELECT r.id
               FROM restaurants r
               JOIN restaurant_managers rm ON r.manager_id = rm.id
               WHERE rm.user_id = $1`,
              [socket.user.id]
            );
            restaurantIds = resRows.rows.map((r) => String(r.id));
          } catch {
            // Fallback to global room if query fails
          }
        }
      }

      if (managerId) {
        socket.join(`manager_${managerId}`);
      }

      const hasExplicitScope =
        Boolean(payload && typeof payload === 'object' && Array.isArray(payload.restaurantIds)) ||
        (socket.user?.role === 'restaurant_manager' && restaurantIds.length > 0);

      if (hasExplicitScope) {
        restaurantIds.forEach((rid) => socket.join(`restaurant_${rid}`));
        // Avoid noisy broadcasts from unrelated restaurants when scoped rooms are used
        socket.leave('restaurant_managers');
        console.log(`Socket ${socket.id} joined ${restaurantIds.length} scoped restaurant room(s)`);
      } else {
        socket.join('restaurant_managers');
        console.log(`Socket ${socket.id} joined restaurant managers room`);
      }
    };
    socket.on('join_manager_room', joinManagerRoom);
    socket.on('join_manager', joinManagerRoom);
    socket.on('join_driver_applications', () => {
      if (socket.user && socket.user.role !== 'restaurant_manager') return;
      socket.join('restaurant_managers');
    });

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
    
    // Handle location updates from drivers (broadcast instantaneously, throttle DB writes)
    socket.on('driver_location_update', async (data = {}) => {
      if (socket.user && socket.user.role !== 'driver') return;
      const { driverId, orderId } = data;
      const coords = extractLngLat(data);
      if (!coords) return;

      const { lng, lat } = coords;
      const effectiveDriverRef = socket.user?.id || driverId;
      const parsedHeading = Number(data.heading);
      const parsedSpeed = Number(data.speed);
      const payload = {
        driverId: effectiveDriverRef,
        orderId,
        location: [lng, lat],
        latitude: lat,
        longitude: lng,
        heading: Number.isFinite(parsedHeading) ? parsedHeading : null,
        speed: Number.isFinite(parsedSpeed) ? parsedSpeed : null,
        timestamp: new Date().toISOString()
      };

      // 1. Broadcast immediately over Socket.IO (zero DB latency)
      let targetOrderIds = orderId ? [orderId] : [];
      if (!orderId && effectiveDriverRef) {
        const cached = driverActiveOrdersCache.get(String(effectiveDriverRef));
        if (cached && Date.now() - cached.cachedAt < ACTIVE_ORDERS_CACHE_MS) {
          targetOrderIds = cached.orderIds;
        } else {
          try {
            const activeOrders = await db.query(
              `SELECT id FROM orders
               WHERE (driver_id = $1 OR driver_id = (SELECT id FROM drivers WHERE user_id = $1 LIMIT 1))
                 AND status IN ('accepted_by_driver', 'order_ready', 'picked_up', 'on_the_way', 'arrived')`,
              [effectiveDriverRef]
            );
            targetOrderIds = activeOrders.rows.map((row) => row.id);
            driverActiveOrdersCache.set(String(effectiveDriverRef), {
              orderIds: targetOrderIds,
              cachedAt: Date.now(),
            });
          } catch {
            // ignore
          }
        }
      }

      const driverPos = { latitude: lat, longitude: lng };
      targetOrderIds.forEach((targetId) => {
        const { route: cachedRoute, needsRefresh } = peekOrderCachedRoute(targetId, driverPos);
        io.to(`order_${targetId}`).emit('driver_location', {
          ...payload,
          orderId: targetId,
          route: cachedRoute || null,
        });

        if (needsRefresh) {
          const lockKey = String(targetId);
          if (!socketRouteRefreshInFlight.has(lockKey)) {
            socketRouteRefreshInFlight.add(lockKey);
            (async () => {
              try {
                const endpoints = await getCachedOrderEndpoints(targetId);
                if (!endpoints || !endpoints.destination) return;
                const refreshed = await getOrderCachedRoute({
                  orderId: targetId,
                  legKey: endpoints.legKey,
                  origin: driverPos,
                  destination: endpoints.destination,
                  currentPosition: driverPos,
                });
                if (refreshed) {
                  io.to(`order_${targetId}`).emit('driver_location', {
                    ...payload,
                    orderId: targetId,
                    route: refreshed,
                    routeRecalculated: true,
                  });
                }
              } catch {
                // ignore transient routing/DB failure on async route refresh
              } finally {
                socketRouteRefreshInFlight.delete(lockKey);
              }
            })();
          }
        }
      });

      // 2. Persist driver location checkpoint to Neon at most every 12s per driver
      const persistKey = String(effectiveDriverRef || orderId || socket.id);
      const now = Date.now();
      const lastPersistedAt = lastDriverDbPersist.get(persistKey) || 0;
      if (now - lastPersistedAt < LOCATION_PERSIST_INTERVAL_MS) {
        return;
      }
      lastDriverDbPersist.set(persistKey, now);

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
        const persistOrderId = orderId || targetOrderIds[0] || null;
        if (persistOrderId && resolvedDriverId) {
          await db.query(
            `INSERT INTO delivery_tracking (order_id, driver_id, location)
             VALUES ($1, (SELECT id FROM drivers WHERE id = $2 OR user_id = $2 LIMIT 1), point($3, $4))`,
            [persistOrderId, resolvedDriverId, lng, lat]
          ).catch(() => {});
        }
      } catch (err) {
        console.warn('Failed to persist socket driver location:', err.message);
      }
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

};

function rememberOrderCustomerUser(orderId, customerUserId) {
  if (!orderId || !customerUserId) return;
  const key = String(orderId);
  if (orderCustomerUserCache.size > 2000) {
    const oldestKey = orderCustomerUserCache.keys().next().value;
    if (oldestKey) orderCustomerUserCache.delete(oldestKey);
  }
  orderCustomerUserCache.set(key, String(customerUserId));
}

function emitOrderUpdate(orderId, data) {
  if (!ioInstance || !orderId) return;

  const status = data?.status || data?.new_status || data?.order?.status;
  // Never broadcast customer delivery verification_code to the shared order room
  let safeData = { ...data };
  if (safeData.order && typeof safeData.order === 'object') {
    const { verification_code, code_expires_at, code_used_at, ...restOrder } = safeData.order;
    safeData.order = restOrder;
  }
  delete safeData.verification_code;

  const payload = {
    ...safeData,
    orderId,
    status
  };

  if (status) {
    orderEndpointsCache.delete(String(orderId));
    clearOrderRouteCache(orderId);
  }

  if (safeData.order?.driver_id) {
    driverActiveOrdersCache.delete(String(safeData.order.driver_id));
  }
  if (safeData.previousDriverId) {
    driverActiveOrdersCache.delete(String(safeData.previousDriverId));
  }
  if (safeData.order?.original_driver_id) {
    driverActiveOrdersCache.delete(String(safeData.order.original_driver_id));
  }

  const directUserId =
    safeData.customerUserId ||
    safeData.order?.customer_user_id ||
    orderCustomerUserCache.get(String(orderId)) ||
    null;

  if (directUserId) {
    rememberOrderCustomerUser(orderId, directUserId);
    ioInstance.to(`order_${orderId}`).to(`user_${directUserId}`).emit('order_update', payload);
    return;
  }

  db.query(
    `SELECT c.user_id
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  )
    .then((res) => {
      const resolvedUserId = res.rows[0]?.user_id || null;
      if (resolvedUserId) {
        rememberOrderCustomerUser(orderId, resolvedUserId);
        ioInstance.to(`order_${orderId}`).to(`user_${resolvedUserId}`).emit('order_update', payload);
      } else {
        ioInstance.to(`order_${orderId}`).emit('order_update', payload);
      }
    })
    .catch(() => {
      ioInstance.to(`order_${orderId}`).emit('order_update', payload);
    });
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

function emitManagerEvent(restaurantId, eventName, data) {
  if (ioInstance && eventName) {
    if (restaurantId) {
      ioInstance.to(`restaurant_${restaurantId}`).to('restaurant_managers').emit(eventName, data);
      return;
    }
    ioInstance.to('restaurant_managers').emit(eventName, data);
  }
}

function emitDriversEvent(eventName, data) {
  if (ioInstance && eventName) {
    ioInstance.to('drivers').emit(eventName, data);
  }
}

function invalidateDriverCache(driverId) {
  if (driverId) {
    driverActiveOrdersCache.delete(String(driverId));
  }
}

module.exports.emitOrderUpdate = emitOrderUpdate;
module.exports.emitUserEvent = emitUserEvent;
module.exports.emitDriverLocation = emitDriverLocation;
module.exports.emitManagerEvent = emitManagerEvent;
module.exports.emitDriversEvent = emitDriversEvent;
module.exports.invalidateDriverCache = invalidateDriverCache;