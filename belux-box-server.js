/**
 * BeLux Box — backend de paiement Stripe + gestion de disponibilité
 * ----------------------------------------------------------------
 * Ce fichier N'EST PAS un fichier statique du site : c'est un petit serveur
 * à déployer séparément (Render, Railway, ou votre propre VPS).
 * Le site (index.html) l'appelle via :
 *   - GET  /api/availability/:date         (combien de box restent ce jour-là)
 *   - POST /api/create-checkout-session    (créer le paiement de l'acompte)
 *
 * STOCKAGE DES RÉSERVATIONS — Upstash Redis (gratuit, persistant)
 * -----------------------------------------------------------------
 * Sur le plan gratuit de Render (et la plupart des hébergeurs gratuits),
 * le disque local n'est PAS persistant : un simple fichier JSON serait
 * effacé à chaque redémarrage du serveur. On utilise donc à la place une
 * petite base Redis gratuite chez Upstash (upstash.com), accessible par
 * simple appel HTTP — pas besoin d'installer quoi que ce soit de plus.
 *
 * Si les variables UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ne
 * sont pas définies (par exemple en test sur votre ordinateur), le serveur
 * bascule automatiquement sur un fichier local (bookings.json) — pratique
 * pour tester, mais À NE PAS UTILISER tel quel en production sur Render
 * gratuit (voir ci-dessus).
 *
 * Installation :
 *   npm init -y
 *   npm install express stripe cors dotenv
 *   créer un fichier .env avec :
 *     STRIPE_SECRET_KEY=sk_live_...
 *     UPSTASH_REDIS_REST_URL=https://....upstash.io
 *     UPSTASH_REDIS_REST_TOKEN=....
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

const SITE_URL = process.env.SITE_URL || 'https://belux-box.be';

// Nombre de box physiques disponibles — LA limite à changer si vous en
// rachetez ou en revendez une.
const CAPACITY_PER_DAY = 3;

// Une session "pending" (paiement commencé mais pas confirmé) ne bloque
// une box que pendant ce délai. Passé ce délai, on considère que le
// client a abandonné et la box redevient disponible.
const PENDING_HOLD_MINUTES = 30;

// ---------------------------------------------------------------
// Stockage des réservations : Upstash Redis si configuré, sinon fichier
// JSON local (mode test uniquement — voir avertissement plus haut).
// Une entrée par date : "bookings:2027-06-12" -> [{sessionId,status,createdAt}, ...]
// ---------------------------------------------------------------
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const LOCAL_DB_PATH = path.join(__dirname, 'bookings.json');

if (!USE_REDIS) {
  console.warn(
    '⚠️  UPSTASH_REDIS_REST_URL / TOKEN non définis — stockage en fichier ' +
    'local (bookings.json). À utiliser en test uniquement : sur Render ' +
    'gratuit, ce fichier serait effacé à chaque redémarrage.'
  );
}

async function getEntriesForDate(dateStr) {
  if (USE_REDIS) {
    const res = await fetch(`${UPSTASH_URL}/get/bookings:${dateStr}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  } else {
    const all = readLocalFile();
    return all[dateStr] || [];
  }
}

async function setEntriesForDate(dateStr, entries) {
  if (USE_REDIS) {
    await fetch(`${UPSTASH_URL}/set/bookings:${dateStr}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(entries),
    });
  } else {
    const all = readLocalFile();
    all[dateStr] = entries;
    writeLocalFile(all);
  }
}

function readLocalFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeLocalFile(data) {
  fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
}

// Nombre de box occupées pour une date : confirmées, + en attente de
// paiement depuis moins de PENDING_HOLD_MINUTES.
async function countTakenSlots(dateStr) {
  const entries = await getEntriesForDate(dateStr);
  const now = Date.now();
  return entries.filter(b => {
    if (b.status === 'confirmed') return true;
    if (b.status === 'pending') {
      const ageMin = (now - b.createdAt) / 60000;
      return ageMin < PENDING_HOLD_MINUTES;
    }
    return false;
  }).length;
}

async function addPendingBooking(dateStr, sessionId) {
  const entries = await getEntriesForDate(dateStr);
  entries.push({ sessionId, status: 'pending', createdAt: Date.now() });
  await setEntriesForDate(dateStr, entries);
}

async function confirmBooking(dateStr, sessionId) {
  const entries = await getEntriesForDate(dateStr);
  const entry = entries.find(b => b.sessionId === sessionId);
  if (entry) entry.status = 'confirmed';
  await setEntriesForDate(dateStr, entries);
}

// ---------------------------------------------------------------
// 1) Disponibilité pour une date donnée — appelé par le site dès que
//    le client choisit une date, pour afficher "2 box restantes",
//    "dernière box disponible" ou "complet".
// ---------------------------------------------------------------
app.get('/api/availability/:date', async (req, res) => {
  const dateStr = req.params.date; // format attendu: YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Format de date invalide' });
  }
  try {
    const taken = await countTakenSlots(dateStr);
    const available = Math.max(0, CAPACITY_PER_DAY - taken);
    res.json({ date: dateStr, capacity: CAPACITY_PER_DAY, taken, available });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de disponibilité' });
  }
});

// ---------------------------------------------------------------
// 2) Créer la session de paiement pour l'ACOMPTE (50%)
//    Revérifie la disponibilité au moment T pour éviter de vendre une
//    4e box si plusieurs personnes réservent en même temps.
// ---------------------------------------------------------------
app.post('/api/create-checkout-session', express.json(), async (req, res) => {
  try {
    const booking = req.body;

    if (!booking.deposit || booking.deposit <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    if (!booking.eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(booking.eventDate)) {
      return res.status(400).json({ error: 'Date d\'événement invalide' });
    }

    const taken = await countTakenSlots(booking.eventDate);
    if (taken >= CAPACITY_PER_DAY) {
      return res.status(409).json({ error: 'complet', message: 'Les 3 box sont déjà réservées pour cette date.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: booking.email,
      payment_method_types: ['card', 'bancontact'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(booking.deposit * 100),
            product_data: {
              name: 'Acompte réservation BeLux Box — ' + booking.formule,
              description:
                'Événement du ' + booking.eventDate +
                ' — Total ' + booking.total + '€, acompte 50% (solde ' +
                booking.balance + '€ débité 7 jours avant l\'événement).',
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        setup_future_usage: 'off_session',
      },
      // Une session Stripe expire par défaut après 24h ; on la raccourcit
      // pour qu'elle corresponde à notre délai de blocage de la box.
      expires_at: Math.floor(Date.now() / 1000) + PENDING_HOLD_MINUTES * 60,
      metadata: {
        formule: booking.formule,
        options: JSON.stringify(booking.options),
        logo: booking.logo,
        deliveryFee: String(booking.deliveryFee),
        total: String(booking.total),
        deposit: String(booking.deposit),
        balance: String(booking.balance),
        eventDate: booking.eventDate,
        eventType: booking.eventType,
        address: booking.address,
        clientName: booking.name,
        clientPhone: booking.phone,
        message: booking.message || '',
      },
      success_url: SITE_URL + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: SITE_URL + '/#reservation',
    });

    // On réserve provisoirement la box dès la création du paiement,
    // pour qu'un autre client ne puisse pas prendre la même place
    // pendant que celui-ci est en train de payer.
    await addPendingBooking(booking.eventDate, session.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// 3) Webhook Stripe : dès que l'acompte est payé, on confirme la
//    réservation (ce qui la rend définitive pour le calcul de
//    disponibilité, au-delà du délai de 30 minutes).
// ---------------------------------------------------------------
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send('Webhook signature invalide: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const eventDate = session.metadata.eventDate;
    try {
      await confirmBooking(eventDate, session.id);
      console.log('Acompte payé, box confirmée pour le', eventDate, '—', session.metadata.clientName);
    } catch (err) {
      console.error('Erreur confirmation réservation:', err);
    }
    // TODO : sauvegarder aussi session.customer + session.payment_intent
    // dans votre base si vous voulez le prélèvement automatique du solde
    // (voir fonction chargeBalanceForBookingsDueToday ci-dessous).
  }

  res.json({ received: true });
});

// ---------------------------------------------------------------
// 4) Prélèvement automatique du SOLDE, 7 jours avant l'événement.
//    (Exemple à brancher sur un cron quotidien — voir BRANCHER-STRIPE.txt)
// ---------------------------------------------------------------
async function chargeBalanceForBookingsDueToday(bookings) {
  for (const booking of bookings) {
    try {
      await stripe.paymentIntents.create({
        amount: Math.round(booking.balance * 100),
        currency: 'eur',
        customer: booking.stripeCustomerId,
        payment_method: booking.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        description: 'Solde réservation BeLux Box — ' + booking.formule,
        metadata: { bookingId: booking.id },
      });
      console.log('Solde prélevé pour la réservation', booking.id);
    } catch (err) {
      console.error('Échec du prélèvement du solde pour', booking.id, err.message);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('BeLux Box payment server running on port ' + PORT));
