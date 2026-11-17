const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const http = require('http');
// const socketIo = require('socket.io'); // Remove this unused line 
const rateLimit = require('express-rate-limit');
const path = require('path');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

dotenv.config();

const db = require('./src/config/database');

const authRoutes = require('./src/routes/authRoutes');
const restaurantRoutes = require('./src/routes/restaurantRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const driverRoutes = require('./src/routes/driverRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const userRoutes = require('./src/routes/userRoutes');
const menuRoutes = require('./src/routes/menuRoutes');
const notificationRoutes = require('./src/routes/notificationRoutes');
const managerRoutes = require('./src/routes/managerRoutes');
const routingRoutes = require('./src/routes/routingRoutes');

// Import middleware
const { errorHandler } = require('./src/middleware/errorHandler');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from your app
  }
});

// ---------------------------------------------------------
// 🚨 CRITICAL FIX: Make 'io' accessible to your Controllers
// ---------------------------------------------------------
app.set('io', io);

// NOTE: All Socket.IO connection handlers (rooms, driver location, status updates)
// live in ./src/socket/index.js and are registered below.

// Rate Limiting (exempt high-frequency GPS location updates, live tracking polls, and payment webhooks)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path.includes('/drivers/location') ||
    req.path.includes('/tracking') ||
    req.path.includes('/route') ||
    req.path.includes('/routing/') ||
    req.path.includes('/payments/webhook'),
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.'
  }
});

// 1. Setup View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 2. Setup Public Folder (for CSS/Images)
app.use(express.static(path.join(__dirname, 'public')));

// 3. Setup Session (Required for Web Login)
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(session({
  store: new (connectPgSimple(session))({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'manager_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.use('/api/', limiter);

// Middleware

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/uploads', express.static('uploads'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// Root route (Render health checks / browsers hitting the bare domain)
app.get('/', (req, res) => {
  res.redirect('/manager/login');
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/routing', routingRoutes);

const managerWebRoutes = require('./routes/managerWeb');
app.use('/manager', managerWebRoutes);

const restaurantWebRoutes = require('./routes/restaurantWeb');
app.use('/restaurant', restaurantWebRoutes);

// Public Driver Registration Web Portal shortcuts (/driver, /driver/register, /driver/apply)
app.get(['/driver', '/driver/register', '/driver/apply'], (req, res) => {
  res.render('driver/register', {
    title: 'Driver Registration Portal · Happy Delivery',
  });
});

// Socket.io setup 
require('./src/socket/index')(io);

// Periodic expired order & stale unpaid order processor (runs every 60 seconds)
const Order = require('./src/models/Order');
const expiredOrdersInterval = setInterval(async () => {
  try {
    await Order.processExpiredOrders();
  } catch (err) {
    console.warn('Order expiration sweep warning:', err.message);
  }
}, 60 * 1000);
if (expiredOrdersInterval.unref) {
  expiredOrdersInterval.unref();
}

app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

process.on('unhandledRejection', (err) => {
  console.error(' CRITICAL UNHANDLED REJECTION:', err);
  if (process.env.NODE_ENV === 'production') {
    server.close(() => process.exit(1));
  }
});

module.exports = { app, server }; 