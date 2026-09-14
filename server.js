require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const plansRoutes = require('./routes/plans');
const adminRoutes = require('./routes/admin');
const paymentsRoutes = require('./routes/payments');
const subscriptionsRoutes = require('./routes/subscriptions');
const newsRoutes = require('./routes/news');
const massBalanceRoutes = require('./routes/massBalance');
const startPaymentReminders = require('./jobs/paymentReminders');
const startNewsFetcher = require('./jobs/newsFetcher');

const app = express();
app.set('trust proxy', 1); // Railway corre detras de un proxy; necesario para que el rate limiting vea la IP real
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use('/auth', authRoutes);
app.use('/plans', plansRoutes);
app.use('/admin', adminRoutes);
app.use('/payments', paymentsRoutes);
app.use('/subscriptions', subscriptionsRoutes);
app.use('/news', newsRoutes);
app.use('/', massBalanceRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

startPaymentReminders();
startNewsFetcher();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Genesis Traza backend corriendo en puerto ${PORT}`));
