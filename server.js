require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const plansRoutes = require('./routes/plans');
const adminRoutes = require('./routes/admin');
const paymentsRoutes = require('./routes/payments');
const subscriptionsRoutes = require('./routes/subscriptions');
const startPaymentReminders = require('./jobs/paymentReminders');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use('/auth', authRoutes);
app.use('/plans', plansRoutes);
app.use('/admin', adminRoutes);
app.use('/payments', paymentsRoutes);
app.use('/subscriptions', subscriptionsRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

startPaymentReminders();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Genesis Traza backend corriendo en puerto ${PORT}`));
