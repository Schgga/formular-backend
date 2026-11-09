import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import authRoutes from './Routes/auth.routes.js';
import settingsRoutes from './Routes/settings.routes.js';
import pricingRoutes from './Routes/pricing.routes.js';
import walletRoutes from './Routes/wallet.routes.js';
import complaintsRoutes from './Routes/complaints.routes.js';
import messagesRoutes from './Routes/messages.routes.js';
import profileRoutes from './Routes/profile.routes.js';
import tutorialsRoutes from './Routes/tutorials.routes.js';
import apikeysRoutes from './Routes/apikeys.routes.js';
import studioRoutes from './Routes/studio.routes.js';
import enginesRoutes from './Routes/engines.routes.js';
import backgroundsRoutes from './Routes/backgrounds.routes.js';
import subscriptionRoutes from './Routes/subscription.routes.js';
import billingRoutes from './Routes/billing.routes.js';
import currencyRoutes from './Routes/currency.routes.js';
import websiteClassesRoutes from './Routes/websiteClasses.routes.js';
import websiteCatalogRoutes from './Routes/websiteCatalog.routes.js';
import userWebsitesRoutes from './Routes/userWebsites.routes.js';
import uploadRoutes from './Routes/upload.routes.js';
import paymentsRoutes from './Routes/payments.routes.js';
import domainsRoutes from './Routes/domains.routes.js';
import adminRoutes from './Routes/admin.routes.js';
import smsRoutes from './Routes/sms.routes.js';
import adminSmsRoutes from './Routes/adminSms.routes.js';
import simulatorRoutes from './Routes/simulator.routes.js';
import adminSimulatorRoutes from './Routes/adminSimulator.routes.js';
import analyticsTrackRoutes from './Routes/analyticsTrack.routes.js';
import analyticsDataRoutes from './Routes/analyticsData.routes.js';
import adminTutorialsRoutes from './Routes/adminTutorials.routes.js';
import directoryRoutes from './routes/directory.routes.js';
import reviewsRoutes from './routes/reviews.routes.js';
import contactsRoutes from './routes/contacts.routes.js';
import campaignRoutes from './routes/campaigns.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import contentRoutes from './routes/content.routes.js';
   import referralRoutes from './routes/referrals.routes.js';
   import googleSetupRoutes from './routes/google.routes.js';
import videoPlannerRoutes from './Routes/videoPlanner.routes.js';
import adminAiWritersRoutes from './Routes/adminAiWriters.routes.js';
import surveysRoutes, { adminRouter as adminSurveysRoutes } from './Routes/surveys.routes.js';
import videoMakerRoutes from './Routes/videoMaker.routes.js';
   
   
   
   




dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Optional: CORS_ORIGINS=https://app.yoursite.com,http://localhost:5173 in .env
// limits which websites may call this API from a browser. Empty = same as before (any).
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(express.json());
app.use('/api/settings', settingsRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/tutorials', tutorialsRoutes);
app.use('/api/admin/api-keys', apikeysRoutes);
app.use('/api/studio', studioRoutes);
app.use('/api/engines', enginesRoutes);
app.use('/public', express.static('public'));
app.use('/api/backgrounds', backgroundsRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/currency', currencyRoutes);
app.use('/api/website-classes', websiteClassesRoutes);
app.use('/api/website-catalog', websiteCatalogRoutes);
app.use('/api/user-websites', userWebsitesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/domains', domainsRoutes);
app.use('/api/video-planner', videoPlannerRoutes);
app.use('/api/video-maker', videoMakerRoutes);
app.use('/api/surveys', surveysRoutes);
app.use('/api/admin/ai-writers', adminAiWritersRoutes);
app.use('/api/admin/surveys', adminSurveysRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/admin', adminSmsRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/api/admin', adminSimulatorRoutes);
app.use('/api/analytics', analyticsTrackRoutes);
app.use('/api/analytics-data', analyticsDataRoutes);
app.use('/api/admin', adminTutorialsRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/email', campaignRoutes);
app.use('/api/wa', whatsappRoutes);  
app.use('/api/content', contentRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/google-setup', googleSetupRoutes); 

app.get('/', (req, res) => {
  res.json({ message: 'Hello from the backend!' });
});

// Test route - confirms the database connection works
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use('/api/auth', authRoutes);

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});