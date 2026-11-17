const express = require('express');
const router = express.Router();
const {
  updateProfile,
  updateRoleProfile,
  getAddresses,
  addAddress,
  setDefaultAddress,
  removeAddress
} = require('../controllers/userController');
const { auth } = require('../middleware/auth');

router.use(auth);

router.put('/profile', updateProfile);
router.put('/role-profile', updateRoleProfile);
router.get('/addresses', getAddresses);
router.post('/addresses', addAddress);
router.patch('/addresses/:addressId/default', setDefaultAddress);
router.delete('/addresses/:addressId', removeAddress);

module.exports = router;