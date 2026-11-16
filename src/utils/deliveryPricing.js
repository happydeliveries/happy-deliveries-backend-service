'use strict';

const axios = require('axios');

const EARTH_RADIUS_KM = 6371;
const GEOCODE_CACHE = new Map();
const MAX_CACHE_ENTRIES = 500;

function toValidLatLng(rawLat, rawLng) {
  let lat = Number(rawLat);
  let lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  // Recover if SA coordinates were accidentally passed reversed (lng in lat range 15..35, lat in -36..-20)
  if ((Math.abs(lat) > 90 && Math.abs(lng) <= 90) || (lat >= 15 && lat <= 35 && lng <= -15 && lng >= -38)) {
    const tmp = lat;
    lat = lng;
    lng = tmp;
  }

  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

function extractCoordsFromAddress(rawAddress) {
  if (!rawAddress) return null;
  let obj = rawAddress;
  if (typeof rawAddress === 'string') {
    try {
      obj = JSON.parse(rawAddress);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const lat = obj.latitude ?? obj.lat ?? obj.y;
  const lng = obj.longitude ?? obj.lng ?? obj.x;
  if (lat !== undefined && lng !== undefined) {
    return toValidLatLng(lat, lng);
  }
  if (Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
    return toValidLatLng(obj.coordinates[1], obj.coordinates[0]);
  }
  return null;
}

function buildAddressQueryVariants(rawAddress) {
  if (!rawAddress) return [];
  if (typeof rawAddress === 'string') {
    const trimmed = rawAddress.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof rawAddress !== 'object') return [];

  const street = String(rawAddress.street || rawAddress.address || rawAddress.address_line1 || '').trim();
  const city = String(rawAddress.city || '').trim();
  const zip = String(rawAddress.postal_code || rawAddress.zip || '').trim();
  const formatted = String(rawAddress.formatted || rawAddress.formattedAddress || '').trim();

  const variants = [];
  if (street && city) {
    variants.push([street, city, zip, 'South Africa'].filter(Boolean).join(', '));
    variants.push([street, city, 'South Africa'].filter(Boolean).join(', '));
  }
  if (formatted && !variants.includes(formatted)) {
    variants.push(formatted);
  }
  if (city) {
    variants.push([city, zip, 'South Africa'].filter(Boolean).join(', '));
    variants.push([city, 'South Africa'].filter(Boolean).join(', '));
  } else if (zip) {
    variants.push([zip, 'South Africa'].filter(Boolean).join(', '));
  }
  return [...new Set(variants.filter(Boolean))];
}

function rememberGeocode(key, value) {
  if (GEOCODE_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = GEOCODE_CACHE.keys().next().value;
    if (oldest) GEOCODE_CACHE.delete(oldest);
  }
  GEOCODE_CACHE.set(key, value);
}

async function geocodeAddressText(queryText) {
  const key = String(queryText || '').trim().toLowerCase();
  if (!key) return null;
  if (GEOCODE_CACHE.has(key)) return GEOCODE_CACHE.get(key);

  const googleKey = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (googleKey) {
    try {
      const gRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { address: queryText, key: googleKey },
        timeout: 3500,
      });
      const loc = gRes.data?.results?.[0]?.geometry?.location;
      const valid = toValidLatLng(loc?.lat, loc?.lng);
      if (valid) {
        rememberGeocode(key, valid);
        return valid;
      }
    } catch {
      // Fallback to Nominatim below
    }
  }

  try {
    const nomRes = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: queryText,
        format: 'json',
        limit: 1,
        countrycodes: 'za',
      },
      headers: {
        'User-Agent': 'HappyDeliveries/1.0',
      },
      timeout: 3500,
    });
    const first = Array.isArray(nomRes.data) ? nomRes.data[0] : null;
    const valid = toValidLatLng(first?.lat, first?.lon);
    if (valid) {
      rememberGeocode(key, valid);
      return valid;
    }
  } catch {
    // Ignore transient geocoder failures
  }

  return null;
}

async function resolveAddressCoordinates(deliveryAddress) {
  const direct = extractCoordsFromAddress(deliveryAddress);
  if (direct) return { ...direct, source: 'client_coords' };

  const queries = buildAddressQueryVariants(deliveryAddress);
  for (const q of queries) {
    const coords = await geocodeAddressText(q);
    if (coords) {
      return { ...coords, source: 'geocoded' };
    }
  }
  return null;
}

/**
 * Computes radial (great-circle Haversine) distance in kilometers between two lat/lng points.
 */
function calculateRadialDistanceKm(lat1, lng1, lat2, lng2) {
  const p1 = toValidLatLng(lat1, lng1);
  const p2 = toValidLatLng(lat2, lng2);
  if (!p1 || !p2) return null;

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
  return +(EARTH_RADIUS_KM * c).toFixed(2);
}

/**
 * Happy Deliveries radial distance pricing (ZAR):
 * - 0 to 5 km:     R20 - R25
 * - >5 to 10 km:   R25 - R40
 * - >10 km:        R45 - R50
 */
function calculateRadialDeliveryFee(distanceKm, deliveryRadiusKm = 15) {
  const d = Math.max(0, Number(distanceKm) || 0);

  if (d <= 5) {
    const fee = Math.round(20 + (d / 5) * 5);
    return Math.min(25, Math.max(20, fee));
  }

  if (d <= 10) {
    const fee = Math.round(25 + ((d - 5) / 5) * 15);
    return Math.min(40, Math.max(25, fee));
  }

  const upperKm = Math.max(Number(deliveryRadiusKm) || 15, 11);
  const spanKm = Math.max(1, upperKm - 10);
  const ratio = Math.min(1, Math.max(0, (d - 10) / spanKm));
  const fee = Math.round(45 + ratio * 5);
  return Math.min(50, Math.max(45, fee));
}

function getDeliveryTierLabel(distanceKm) {
  const d = Math.max(0, Number(distanceKm) || 0);
  if (d <= 5) return '0-5 km (R20-R25)';
  if (d <= 10) return '5-10 km (R25-R40)';
  return '10+ km (R45-R50)';
}

function evaluateDeliveryForOrder({
  restaurantLat,
  restaurantLng,
  deliveryRadiusKm,
  customerLat,
  customerLng,
  restaurantName = 'This restaurant',
}) {
  const maxRadiusKm = Number(deliveryRadiusKm) > 0 ? Number(deliveryRadiusKm) : 5;
  const rCoords = toValidLatLng(restaurantLat, restaurantLng);
  const cCoords = toValidLatLng(customerLat, customerLng);

  if (!rCoords) {
    return {
      deliverable: true,
      distance_km: null,
      max_radius_km: maxRadiusKm,
      delivery_fee: 20,
      tier_label: '0-5 km (R20-R25)',
      error: null,
    };
  }

  if (!cCoords) {
    return {
      deliverable: false,
      distance_km: null,
      max_radius_km: maxRadiusKm,
      delivery_fee: null,
      tier_label: null,
      error: 'Could not determine coordinates for this delivery address. Please tap "Use GPS" or enter a valid street and city.',
    };
  }

  const distanceKm = calculateRadialDistanceKm(
    rCoords.latitude,
    rCoords.longitude,
    cCoords.latitude,
    cCoords.longitude
  );

  if (distanceKm > maxRadiusKm) {
    return {
      deliverable: false,
      distance_km: distanceKm,
      max_radius_km: maxRadiusKm,
      delivery_fee: null,
      tier_label: null,
      error: `${restaurantName} only delivers within ${maxRadiusKm} km, but your delivery address is ${distanceKm.toFixed(1)} km away.`,
    };
  }

  const deliveryFee = calculateRadialDeliveryFee(distanceKm, maxRadiusKm);
  return {
    deliverable: true,
    distance_km: distanceKm,
    max_radius_km: maxRadiusKm,
    delivery_fee: deliveryFee,
    tier_label: getDeliveryTierLabel(distanceKm),
    error: null,
  };
}

module.exports = {
  toValidLatLng,
  extractCoordsFromAddress,
  resolveAddressCoordinates,
  calculateRadialDistanceKm,
  calculateRadialDeliveryFee,
  getDeliveryTierLabel,
  evaluateDeliveryForOrder,
};
