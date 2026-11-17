const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { normalizeLatLng, getDirectionsBetweenCoords } = require('../utils/routing');

function parseCoordPairParam(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return null;
  }
  return normalizeLatLng({ latitude: parts[0], longitude: parts[1] });
}

// GET /api/routing/directions?fromLat=...&fromLng=...&toLat=...&toLng=...
router.get('/directions', auth, async (req, res) => {
  try {
    const {
      fromLat,
      fromLng,
      originLat,
      originLng,
      toLat,
      toLng,
      destLat,
      destLng,
      origin: originQuery,
      destination: destinationQuery,
    } = req.query;

    const origin =
      parseCoordPairParam(originQuery) ||
      normalizeLatLng({
        latitude: fromLat ?? originLat,
        longitude: fromLng ?? originLng,
      });

    const destination =
      parseCoordPairParam(destinationQuery) ||
      normalizeLatLng({
        latitude: toLat ?? destLat,
        longitude: toLng ?? destLng,
      });

    if (!origin || !destination) {
      return res.status(400).json({
        success: false,
        error: 'Valid origin and destination coordinates are required',
      });
    }

    const route = await getDirectionsBetweenCoords(origin, destination);
    res.json({
      success: true,
      data: route,
    });
  } catch (error) {
    console.error('Get directions error:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to calculate directions right now',
    });
  }
});

module.exports = router;
