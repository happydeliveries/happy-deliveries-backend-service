'use strict';

const axios = require('axios');
const { toValidLatLng, resolveAddressCoordinates } = require('./deliveryPricing');

const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const OSRM_TIMEOUT_MS = 4500;
const ROUTE_CACHE_TTL_MS = 35000; // Re-fetch OSRM at most every 35s unless off-route
const OFF_ROUTE_THRESHOLD_METERS = 120;
const DIRECTION_CACHE_TTL_MS = 45000;
const MAX_CACHE_ENTRIES = 500;
const EARTH_RADIUS_METERS = 6371000;

const ORDER_ROUTE_CACHE = new Map();
const PAIR_ROUTE_CACHE = new Map();
const IN_FLIGHT_ROUTES = new Map();

const PICKUP_LEG_STATUSES = new Set(['accepted_by_driver', 'order_ready']);
const DROPOFF_LEG_STATUSES = new Set(['picked_up', 'on_the_way', 'arrived']);

function setBoundedCache(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function normalizeLatLng(input) {
  if (!input) return null;
  if (Array.isArray(input) && input.length >= 2) {
    // Support GeoJSON/PostGIS [lng, lat] or [lat, lng] via SA heuristic inside toValidLatLng
    return toValidLatLng(input[1], input[0]) || toValidLatLng(input[0], input[1]);
  }
  if (typeof input === 'object') {
    if (Array.isArray(input.coordinates) && input.coordinates.length >= 2) {
      return toValidLatLng(input.coordinates[1], input.coordinates[0]);
    }
    const lat = input.latitude ?? input.lat ?? input.y;
    const lng = input.longitude ?? input.lng ?? input.x;
    return toValidLatLng(lat, lng);
  }
  return null;
}

function haversineMeters(p1, p2) {
  if (!p1 || !p2) return Infinity;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(p2.latitude - p1.latitude);
  const dLng = toRad(p2.longitude - p1.longitude);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.latitude)) *
      Math.cos(toRad(p2.latitude)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

function computePolylineMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    total += haversineMeters(coords[i], coords[i + 1]);
  }
  return total;
}

/**
 * Equirectangular local projection for fast segment-to-point distance & projection.
 */
function projectPointToSegment(point, segA, segB) {
  const refLatRad = (point.latitude * Math.PI) / 180;
  const cosLat = Math.max(0.01, Math.cos(refLatRad));
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * cosLat;

  const ax = (segA.longitude - point.longitude) * metersPerDegLng;
  const ay = (segA.latitude - point.latitude) * metersPerDegLat;
  const bx = (segB.longitude - point.longitude) * metersPerDegLng;
  const by = (segB.latitude - point.latitude) * metersPerDegLat;

  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq <= 1e-6) {
    return {
      distanceMeters: Math.hypot(ax, ay),
      projectedPoint: segA,
    };
  }

  // Since point is origin (0,0), projection parameter t along AB is -(A . AB) / |AB|^2
  const rawT = -(ax * abx + ay * aby) / abLenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const px = ax + t * abx;
  const py = ay + t * aby;

  return {
    distanceMeters: Math.hypot(px, py),
    projectedPoint: {
      latitude: +(segA.latitude + t * (segB.latitude - segA.latitude)).toFixed(6),
      longitude: +(segA.longitude + t * (segB.longitude - segA.longitude)).toFixed(6),
    },
  };
}

function distanceToPolylineMeters(coords, point) {
  if (!Array.isArray(coords) || coords.length === 0 || !point) return Infinity;
  if (coords.length === 1) return haversineMeters(coords[0], point);

  let minDistance = Infinity;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const { distanceMeters } = projectPointToSegment(point, coords[i], coords[i + 1]);
    if (distanceMeters < minDistance) {
      minDistance = distanceMeters;
    }
  }
  return minDistance;
}

function trimPolylineFromPosition(coords, currentPos, maxSnapMeters = 180) {
  if (!Array.isArray(coords) || coords.length < 2 || !currentPos) {
    return coords || [];
  }

  let bestIndex = 0;
  let bestDistance = Infinity;
  let bestProjected = coords[0];

  for (let i = 0; i < coords.length - 1; i += 1) {
    const { distanceMeters, projectedPoint } = projectPointToSegment(currentPos, coords[i], coords[i + 1]);
    if (distanceMeters < bestDistance) {
      bestDistance = distanceMeters;
      bestIndex = i;
      bestProjected = projectedPoint;
    }
  }

  if (bestDistance > maxSnapMeters) {
    return coords;
  }

  const trimmed = [bestProjected, ...coords.slice(bestIndex + 1)];
  if (trimmed.length === 1) {
    trimmed.push(coords[coords.length - 1]);
  }
  return trimmed;
}

function toLeafletCoords(reactNativeCoords) {
  return reactNativeCoords.map((pt) => [pt.latitude, pt.longitude]);
}

function flipGeoJsonCoordinates(geoCoords = []) {
  const reactNativeCoords = [];
  const leafletCoords = [];

  for (const pair of geoCoords) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    reactNativeCoords.push({ latitude: lat, longitude: lng });
    leafletCoords.push([lat, lng]);
  }

  return { reactNativeCoords, leafletCoords };
}

function formatModifierLabel(modifier) {
  const map = {
    'sharp left': 'sharp left',
    left: 'left',
    'slight left': 'slight left',
    straight: 'straight',
    'slight right': 'slight right',
    right: 'right',
    'sharp right': 'sharp right',
    uturn: 'U-turn',
  };
  return map[modifier] || modifier || '';
}

function formatOsrmStep(step) {
  const maneuver = step?.maneuver || {};
  const type = maneuver.type || 'continue';
  const modifier = maneuver.modifier || '';
  const modLabel = formatModifierLabel(modifier);
  const streetName = String(step?.name || '').trim();
  const ontoStreet = streetName ? ` onto ${streetName}` : '';

  let instruction = 'Continue straight';
  switch (type) {
    case 'depart':
      instruction = streetName ? `Head${modLabel ? ` ${modLabel}` : ''} on ${streetName}` : 'Start route';
      break;
    case 'arrive':
      instruction = modLabel ? `Arrive at destination on the ${modLabel}` : 'Arrive at destination';
      break;
    case 'turn':
      instruction = modLabel === 'U-turn'
        ? `Make a U-turn${ontoStreet}`
        : `Turn ${modLabel || 'ahead'}${ontoStreet}`;
      break;
    case 'new name':
      instruction = streetName ? `Continue onto ${streetName}` : 'Continue straight';
      break;
    case 'merge':
      instruction = `Merge${modLabel ? ` ${modLabel}` : ''}${ontoStreet}`;
      break;
    case 'on ramp':
    case 'off ramp':
      instruction = `Take the ramp${modLabel ? ` ${modLabel}` : ''}${ontoStreet}`;
      break;
    case 'fork':
      instruction = `Keep ${modLabel || 'straight'} at the fork${ontoStreet}`;
      break;
    case 'end of road':
      instruction = `Turn ${modLabel || 'at end of road'}${ontoStreet}`;
      break;
    case 'roundabout':
    case 'rotary': {
      const exitNum = maneuver.exit ? `take exit ${maneuver.exit}` : 'enter roundabout';
      instruction = `At the roundabout, ${exitNum}${ontoStreet}`;
      break;
    }
    case 'exit roundabout':
      instruction = `Exit roundabout${ontoStreet}`;
      break;
    default:
      instruction = modLabel && modLabel !== 'straight'
        ? `Keep ${modLabel}${ontoStreet}`
        : streetName
          ? `Continue on ${streetName}`
          : 'Continue straight';
      break;
  }

  const rawLoc = Array.isArray(maneuver.location) ? maneuver.location : null;
  const coordinate = rawLoc && rawLoc.length >= 2
    ? { latitude: Number(rawLoc[1]), longitude: Number(rawLoc[0]) }
    : null;

  return {
    instruction,
    streetName: streetName || null,
    distanceMeters: Math.round(Number(step?.distance) || 0),
    durationSeconds: Math.round(Number(step?.duration) || 0),
    maneuverType: type,
    modifier: modifier || null,
    coordinate,
  };
}

function buildHaversineFallback(origin, destination) {
  const straightMeters = haversineMeters(origin, destination);
  const roadEstimateKm = Math.max(0.05, +((straightMeters / 1000) * 1.28).toFixed(2));
  const durationMinutes = straightMeters < 40
    ? 1
    : Math.max(1, Math.round((roadEstimateKm / 28) * 60));

  const reactNativeCoords = [
    { latitude: origin.latitude, longitude: origin.longitude },
    { latitude: destination.latitude, longitude: destination.longitude },
  ];

  return {
    reactNativeCoords,
    leafletCoords: toLeafletCoords(reactNativeCoords),
    distanceKm: +(straightMeters / 1000).toFixed(2),
    durationMinutes,
    steps: [
      {
        instruction: 'Head toward destination',
        streetName: null,
        distanceMeters: Math.round(straightMeters),
        durationSeconds: durationMinutes * 60,
        maneuverType: 'depart',
        modifier: null,
        coordinate: { latitude: origin.latitude, longitude: origin.longitude },
      },
    ],
    source: 'haversine_fallback',
    fallback: true,
    origin,
    destination,
    fetchedAt: Date.now(),
  };
}

async function fetchOsrmDrivingRoute(origin, destination) {
  const straightMeters = haversineMeters(origin, destination);
  if (straightMeters < 15) {
    const reactNativeCoords = [
      { latitude: origin.latitude, longitude: origin.longitude },
      { latitude: destination.latitude, longitude: destination.longitude },
    ];
    return {
      reactNativeCoords,
      leafletCoords: toLeafletCoords(reactNativeCoords),
      distanceKm: 0,
      durationMinutes: 1,
      steps: [],
      source: 'arrived_proximity',
      fallback: false,
      origin,
      destination,
      fetchedAt: Date.now(),
    };
  }

  const url = `${OSRM_BASE_URL}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson&steps=true`;

  try {
    const response = await axios.get(url, {
      timeout: OSRM_TIMEOUT_MS,
      headers: {
        'User-Agent': 'HappyDeliveries-Routing/1.0',
      },
    });

    const route = response.data?.routes?.[0];
    const geoCoords = route?.geometry?.coordinates;
    if (response.data?.code !== 'Ok' || !route || !Array.isArray(geoCoords) || geoCoords.length < 2) {
      return buildHaversineFallback(origin, destination);
    }

    const { reactNativeCoords, leafletCoords } = flipGeoJsonCoordinates(geoCoords);
    if (reactNativeCoords.length < 2) {
      return buildHaversineFallback(origin, destination);
    }

    const distanceKm = +((Number(route.distance) || 0) / 1000).toFixed(2);
    const durationMinutes = Math.max(1, Math.round((Number(route.duration) || 60) / 60));

    const rawSteps = Array.isArray(route.legs?.[0]?.steps) ? route.legs[0].steps : [];
    const steps = rawSteps
      .map(formatOsrmStep)
      .filter((s, idx, arr) => idx === 0 || s.distanceMeters > 0 || s.maneuverType === 'arrive' || idx < arr.length - 1);

    return {
      reactNativeCoords,
      leafletCoords,
      distanceKm,
      durationMinutes,
      steps,
      source: 'osrm',
      fallback: false,
      origin,
      destination,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.warn('OSRM routing fallback triggered:', err.message);
    return buildHaversineFallback(origin, destination);
  }
}

function buildTrimmedView(cachedEntry, currentPos) {
  const fullCoords = cachedEntry.fullReactNativeCoords || cachedEntry.reactNativeCoords;
  if (!currentPos || cachedEntry.fallback || fullCoords.length < 2) {
    return {
      reactNativeCoords: fullCoords,
      leafletCoords: toLeafletCoords(fullCoords),
      distanceKm: cachedEntry.distanceKm,
      durationMinutes: cachedEntry.durationMinutes,
      steps: cachedEntry.steps,
      source: cachedEntry.source,
      fallback: cachedEntry.fallback,
      origin: cachedEntry.origin,
      destination: cachedEntry.destination,
      fetchedAt: cachedEntry.fetchedAt,
    };
  }

  const trimmedCoords = trimPolylineFromPosition(fullCoords, currentPos);
  const fullMeters = Math.max(1, computePolylineMeters(fullCoords));
  const remainingMeters = computePolylineMeters(trimmedCoords);
  const ratio = Math.min(1, Math.max(0, remainingMeters / fullMeters));

  const distanceKm = +(cachedEntry.distanceKm * ratio).toFixed(2);
  const durationMinutes = remainingMeters < 50
    ? 1
    : Math.max(1, Math.round(cachedEntry.durationMinutes * ratio));

  return {
    reactNativeCoords: trimmedCoords,
    leafletCoords: toLeafletCoords(trimmedCoords),
    distanceKm,
    durationMinutes,
    steps: cachedEntry.steps,
    source: cachedEntry.source,
    fallback: cachedEntry.fallback,
    origin: currentPos,
    destination: cachedEntry.destination,
    fetchedAt: cachedEntry.fetchedAt,
  };
}

/**
 * Fetches or reuses a cached OSRM route for an order leg.
 * Re-fetches at most once every 35s OR immediately if the leg changes or driver deviates >120m.
 */
async function getOrderCachedRoute({
  orderId,
  legKey,
  origin,
  destination,
  currentPosition = null,
  forceRefresh = false,
}) {
  const validOrigin = normalizeLatLng(origin);
  const validDest = normalizeLatLng(destination);
  if (!validOrigin || !validDest) return null;

  const activePos = normalizeLatLng(currentPosition) || validOrigin;
  const cacheKey = `order:${orderId}`;
  const existing = ORDER_ROUTE_CACHE.get(cacheKey);
  const now = Date.now();

  if (!forceRefresh && existing && existing.legKey === legKey) {
    const withinTtl = now - existing.fetchedAt < ROUTE_CACHE_TTL_MS;
    const sameDest = haversineMeters(existing.destination, validDest) <= 60;
    const offRouteDist = distanceToPolylineMeters(existing.fullReactNativeCoords, activePos);
    const onRoute = existing.fallback
      ? haversineMeters(existing.origin, activePos) <= OFF_ROUTE_THRESHOLD_METERS
      : offRouteDist <= OFF_ROUTE_THRESHOLD_METERS;

    if (withinTtl && sameDest && onRoute) {
      return {
        ...buildTrimmedView(existing, activePos),
        leg: legKey,
        cached: true,
        recalculated: false,
      };
    }
  }

  const flightKey = `${cacheKey}:${legKey}`;
  if (IN_FLIGHT_ROUTES.has(flightKey)) {
    const inFlightResult = await IN_FLIGHT_ROUTES.get(flightKey);
    return {
      ...buildTrimmedView(inFlightResult, activePos),
      leg: legKey,
      cached: true,
      recalculated: false,
    };
  }

  const promise = (async () => {
    const fresh = await fetchOsrmDrivingRoute(activePos, validDest);
    const entry = {
      ...fresh,
      legKey,
      fullReactNativeCoords: fresh.reactNativeCoords,
    };
    // Only cache full duration for OSRM routes or short-lived fallbacks (avoid sticking fallback for full 35s)
    if (fresh.fallback) {
      entry.fetchedAt = Date.now() - Math.floor(ROUTE_CACHE_TTL_MS * 0.65);
    }
    setBoundedCache(ORDER_ROUTE_CACHE, cacheKey, entry);
    return entry;
  })();

  IN_FLIGHT_ROUTES.set(flightKey, promise);
  try {
    const freshEntry = await promise;
    return {
      ...buildTrimmedView(freshEntry, activePos),
      leg: legKey,
      cached: false,
      recalculated: true,
    };
  } finally {
    IN_FLIGHT_ROUTES.delete(flightKey);
  }
}

/**
 * Synchronous read-only view of the cached order route if fresh & on-route (zero latency inside socket hot-path),
 * returning { route, needsRefresh }.
 */
function peekOrderCachedRoute(orderId, currentPos) {
  const existing = ORDER_ROUTE_CACHE.get(`order:${orderId}`);
  const validPos = normalizeLatLng(currentPos);
  if (!existing || !validPos) {
    return { route: null, needsRefresh: true };
  }

  const age = Date.now() - existing.fetchedAt;
  const offRouteDist = distanceToPolylineMeters(existing.fullReactNativeCoords, validPos);
  const offRoute = existing.fallback
    ? haversineMeters(existing.origin, validPos) > OFF_ROUTE_THRESHOLD_METERS
    : offRouteDist > OFF_ROUTE_THRESHOLD_METERS;

  return {
    route: {
      ...buildTrimmedView(existing, validPos),
      leg: existing.legKey,
      cached: true,
      recalculated: false,
    },
    needsRefresh: age >= ROUTE_CACHE_TTL_MS || offRoute,
  };
}

/**
 * Cached coordinate-pair OSRM directions lookup for /api/routing/directions and static preview legs.
 */
async function getDirectionsBetweenCoords(origin, destination) {
  const validOrigin = normalizeLatLng(origin);
  const validDest = normalizeLatLng(destination);
  if (!validOrigin || !validDest) return null;

  const pairKey = [
    validOrigin.latitude.toFixed(4),
    validOrigin.longitude.toFixed(4),
    validDest.latitude.toFixed(4),
    validDest.longitude.toFixed(4),
  ].join(':');

  const cached = PAIR_ROUTE_CACHE.get(pairKey);
  if (cached && Date.now() - cached.fetchedAt < DIRECTION_CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  if (IN_FLIGHT_ROUTES.has(`pair:${pairKey}`)) {
    const res = await IN_FLIGHT_ROUTES.get(`pair:${pairKey}`);
    return { ...res, cached: true };
  }

  const promise = (async () => {
    const route = await fetchOsrmDrivingRoute(validOrigin, validDest);
    const entry = {
      ...route,
      fetchedAt: route.fallback ? Date.now() - Math.floor(DIRECTION_CACHE_TTL_MS * 0.7) : Date.now(),
    };
    setBoundedCache(PAIR_ROUTE_CACHE, pairKey, entry);
    return entry;
  })();

  IN_FLIGHT_ROUTES.set(`pair:${pairKey}`, promise);
  try {
    const res = await promise;
    return { ...res, cached: false };
  } finally {
    IN_FLIGHT_ROUTES.delete(`pair:${pairKey}`);
  }
}

async function resolveOrderRouteEndpoints(order, driverOverrideCoords = null) {
  if (!order) return null;

  const driverCoords = normalizeLatLng(driverOverrideCoords) || normalizeLatLng(order.driver_location);
  const restaurantCoords =
    normalizeLatLng(order.restaurant_location) ||
    (order.restaurant_address ? await resolveAddressCoordinates(order.restaurant_address) : null);
  const customerCoords = order.delivery_address
    ? await resolveAddressCoordinates(order.delivery_address)
    : null;

  const status = String(order.status || '');
  let legKey = 'preview_to_customer';
  let origin = restaurantCoords;
  let destination = customerCoords;

  if (DROPOFF_LEG_STATUSES.has(status)) {
    legKey = 'to_customer';
    origin = driverCoords || restaurantCoords;
    destination = customerCoords;
  } else if (PICKUP_LEG_STATUSES.has(status)) {
    legKey = 'to_restaurant';
    origin = driverCoords || restaurantCoords;
    destination = restaurantCoords;
  }

  return {
    status,
    legKey,
    driverCoords,
    restaurantCoords,
    customerCoords,
    origin,
    destination,
    hasSeparatePreviewLeg: Boolean(
      PICKUP_LEG_STATUSES.has(status) && restaurantCoords && customerCoords
    ),
  };
}

function clearOrderRouteCache(orderId) {
  if (orderId) {
    ORDER_ROUTE_CACHE.delete(`order:${orderId}`);
  }
}

module.exports = {
  normalizeLatLng,
  haversineMeters,
  distanceToPolylineMeters,
  trimPolylineFromPosition,
  getOrderCachedRoute,
  peekOrderCachedRoute,
  getDirectionsBetweenCoords,
  resolveOrderRouteEndpoints,
  clearOrderRouteCache,
  PICKUP_LEG_STATUSES,
  DROPOFF_LEG_STATUSES,
};
