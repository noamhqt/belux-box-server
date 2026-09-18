/**
 * BeLux Box — backend de paiement Stripe + disponibilité + admin
 * ----------------------------------------------------------------
 * Ce fichier N'EST PAS un fichier statique du site : c'est un petit serveur
 * à déployer séparément (Render, Railway, ou votre propre VPS).
 *
 * Routes publiques (appelées par index.html) :
 *   - GET  /api/availability/:date         (combien de box restent ce jour-là)
 *   - GET  /api/settings                   (tarif km actuel, pour le calcul de livraison)
 *   - POST /api/create-checkout-session    (créer le paiement de l'acompte)
 *   - POST /api/stripe-webhook             (confirmation Stripe)
 *
 * Routes admin (appelées par admin.html, protégées par un mot de passe) :
 *   - GET   /api/admin/bookings            (liste de toutes les réservations)
 *   - PATCH /api/admin/bookings/:date/:sessionId   (marquer le solde payé/impayé)
 *   - PATCH /api/admin/settings            (changer le tarif au km)
 *
 * STOCKAGE — Upstash Redis (gratuit, persistant)
 * -----------------------------------------------------------------
 * Sur le plan gratuit de Render, le disque local n'est PAS persistant.
 * On utilise donc Upstash Redis (upstash.com), accessible par simple appel
 * HTTP. Si UPSTASH_REDIS_REST_URL / TOKEN ne sont pas définis, le serveur
 * bascule sur un fichier local (bookings.json) — pratique pour tester sur
 * votre ordinateur, à ne pas utiliser tel quel sur Render gratuit.
 *
 * Variables d'environnement nécessaires (à mettre sur Render) :
 *   STRIPE_SECRET_KEY        = sk_live_... (ou sk_test_... pour tester)
 *   STRIPE_WEBHOOK_SECRET    = whsec_...
 *   SITE_URL                 = https://belux-box.com
 *   UPSTASH_REDIS_REST_URL   = https://....upstash.io
 *   UPSTASH_REDIS_REST_TOKEN = ....
 *   ADMIN_KEY                = un mot de passe de votre choix, pour le dashboard
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

const SITE_URL = process.env.SITE_URL || 'https://belux-box.com';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Nombre de box physiques disponibles — LA limite à changer si vous en
// rachetez ou en revendez une.
const CAPACITY_PER_DAY = 3;

// Une session "pending" (paiement commencé mais pas confirmé) ne bloque
// une box que pendant ce délai. Passé ce délai, on considère que le
// client a abandonné et la box redevient disponible.
const PENDING_HOLD_MINUTES = 30;

// Valeurs par défaut du tarif de livraison — modifiables ensuite depuis le
// dashboard admin sans avoir à retoucher le code (voir /api/settings).
const DEFAULT_SETTINGS = {
  ratePerKm: 0.45,
  freeKm: 35,
};

// ---------------------------------------------------------------
// Stockage : Upstash Redis si configuré, sinon fichier JSON local.
// ---------------------------------------------------------------
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const LOCAL_DB_PATH = path.join(__dirname, 'bookings.json');
const LOCAL_SETTINGS_PATH = path.join(__dirname, 'settings.json');

if (!USE_REDIS) {
  console.warn(
    '⚠️  UPSTASH_REDIS_REST_URL / TOKEN non définis — stockage en fichier ' +
    'local. À utiliser en test uniquement : sur Render gratuit, ce fichier ' +
    'serait effacé à chaque redémarrage.'
  );
}

async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  });
}

// Commande Redis générique (utilisée pour lister toutes les clés bookings:*)
async function redisCommand(commandArray) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commandArray),
  });
  const data = await res.json();
  return data.result;
}

function readLocalFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeLocalFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function getEntriesForDate(dateStr) {
  if (USE_REDIS) {
    return (await redisGet(`bookings:${dateStr}`)) || [];
  }
  const all = readLocalFile(LOCAL_DB_PATH);
  return all[dateStr] || [];
}

async function setEntriesForDate(dateStr, entries) {
  if (USE_REDIS) {
    await redisSet(`bookings:${dateStr}`, entries);
  } else {
    const all = readLocalFile(LOCAL_DB_PATH);
    all[dateStr] = entries;
    writeLocalFile(LOCAL_DB_PATH, all);
  }
}

// Retourne { date: [entries...] } pour TOUTES les dates ayant des réservations.
async function getAllBookings() {
  if (USE_REDIS) {
    const keys = (await redisCommand(['KEYS', 'bookings:*'])) || [];
    const result = {};
    for (const key of keys) {
      const dateStr = key.replace('bookings:', '');
      result[dateStr] = (await redisGet(key)) || [];
    }
    return result;
  }
  return readLocalFile(LOCAL_DB_PATH);
}

async function getSettings() {
  let stored;
  if (USE_REDIS) {
    stored = await redisGet('settings:delivery');
  } else {
    stored = readLocalFile(LOCAL_SETTINGS_PATH).delivery;
  }
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  if (USE_REDIS) {
    await redisSet('settings:delivery', updated);
  } else {
    writeLocalFile(LOCAL_SETTINGS_PATH, { delivery: updated });
  }
  return updated;
}

// Nombre de box occupées pour une date : confirmées, + en attente de
// paiement depuis moins de PENDING_HOLD_MINUTES. Une date bloquée
// manuellement (voir getBlockedDates) est toujours comptée comme complète.
async function countTakenSlots(dateStr) {
  const blocked = await getBlockedDates();
  if (blocked[dateStr]) return CAPACITY_PER_DAY;

  const entries = await getEntriesForDate(dateStr);
  const now = Date.now();
  return entries.filter(b => {
    if (b.status === 'cancelled') return false;
    if (b.status === 'confirmed') return true;
    if (b.status === 'pending') {
      const ageMin = (now - b.createdAt) / 60000;
      return ageMin < PENDING_HOLD_MINUTES;
    }
    return false;
  }).length;
}

async function addPendingBooking(dateStr, sessionId, booking) {
  const entries = await getEntriesForDate(dateStr);
  entries.push({
    sessionId,
    status: 'pending',
    createdAt: Date.now(),
    clientName: booking.name,
    email: booking.email,
    phone: booking.phone,
    formule: booking.formule,
    options: booking.options,
    logo: booking.logo,
    deliveryFee: booking.deliveryFee,
    total: booking.total,
    deposit: booking.deposit,
    balance: booking.balance,
    address: booking.address,
    eventDate: booking.eventDate,
    message: booking.message || '',
    balanceStatus: 'not_due', // not_due | unpaid | paid
  });
  await setEntriesForDate(dateStr, entries);
}

async function confirmBooking(dateStr, sessionId, session) {
  const entries = await getEntriesForDate(dateStr);
  const entry = entries.find(b => b.sessionId === sessionId);
  if (entry) {
    entry.status = 'confirmed';
    entry.confirmedAt = Date.now();
    entry.balanceStatus = 'unpaid';
    // Conservés pour un futur prélèvement automatique du solde.
    entry.stripeCustomerId = session.customer || null;
    entry.stripePaymentIntentId = session.payment_intent || null;
  }
  await setEntriesForDate(dateStr, entries);
}

async function setBalanceStatus(dateStr, sessionId, status) {
  const entries = await getEntriesForDate(dateStr);
  const entry = entries.find(b => b.sessionId === sessionId);
  if (!entry) return false;
  entry.balanceStatus = status;
  await setEntriesForDate(dateStr, entries);
  return true;
}

async function updateBookingFields(dateStr, sessionId, fields) {
  const entries = await getEntriesForDate(dateStr);
  const entry = entries.find(b => b.sessionId === sessionId);
  if (!entry) return false;
  Object.assign(entry, fields);
  await setEntriesForDate(dateStr, entries);
  return true;
}

// ---------------------------------------------------------------
// Dates bloquées manuellement (salon, maintenance, jour off...).
// Stockées à part : une date bloquée rend le jour indisponible pour
// TOUTE nouvelle réservation, quel que soit le nombre de box déjà
// prises, sans toucher aux réservations existantes.
// ---------------------------------------------------------------
async function getBlockedDates() {
  if (USE_REDIS) {
    return (await redisGet('blocked_dates')) || {};
  }
  return readLocalFile(LOCAL_SETTINGS_PATH).blocked || {};
}

async function setBlockedDates(data) {
  if (USE_REDIS) {
    await redisSet('blocked_dates', data);
  } else {
    const all = readLocalFile(LOCAL_SETTINGS_PATH);
    all.blocked = data;
    writeLocalFile(LOCAL_SETTINGS_PATH, all);
  }
}

// ---------------------------------------------------------------
// Authentification admin — simple mot de passe partagé (pas de compte
// utilisateur). Le dashboard l'envoie dans l'en-tête X-Admin-Key.
// ---------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY non configurée sur le serveur' });
  }
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Mot de passe admin invalide' });
  }
  next();
}

// ---------------------------------------------------------------
// Disponibilité pour une date donnée.
// ---------------------------------------------------------------
app.get('/api/availability/:date', async (req, res) => {
  const dateStr = req.params.date;
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
// Réglages publics (tarif km) — utilisé par le site pour calculer le
// supplément de livraison affiché au client.
// ---------------------------------------------------------------
app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error(err);
    res.json(DEFAULT_SETTINGS);
  }
});

// ---------------------------------------------------------------
// Créer la session de paiement pour l'ACOMPTE (50%)
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
      success_url: SITE_URL + '/?paiement=confirme&session_id={CHECKOUT_SESSION_ID}#reservation',
      cancel_url: SITE_URL + '/#reservation',
    });

    await addPendingBooking(booking.eventDate, session.id, booking);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Webhook Stripe : confirmation + email récapitulatif.
// ---------------------------------------------------------------
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mjyvnazj';

async function sendBookingRecapEmail(session) {
  const m = session.metadata;
  let options = {};
  try { options = JSON.parse(m.options || '{}'); } catch (e) {}
  const optionsList = Object.entries(options)
    .filter(([, v]) => v === true || v === 'true')
    .map(([k]) => k)
    .join(', ') || 'aucune';

  const message = [
    `Nouvelle réservation confirmée (acompte payé)`,
    ``,
    `Client : ${m.clientName || '—'}`,
    `Email : ${session.customer_details?.email || session.customer_email || '—'}`,
    `Téléphone : ${m.clientPhone || '—'}`,
    ``,
    `Formule : ${m.formule || '—'}`,
    `Options : ${optionsList}`,
    `Bandelette/logo : ${m.logo || '—'}`,
    `Date de l'événement : ${m.eventDate || '—'}`,
    `Adresse de livraison : ${m.address || '—'}`,
    `Supplément livraison : ${m.deliveryFee || '0'}€`,
    ``,
    `Total TTC : ${m.total || '—'}€`,
    `Acompte payé : ${m.deposit || '—'}€`,
    `Solde restant (à prélever 7 jours avant) : ${m.balance || '—'}€`,
    ``,
    `Message du client : ${m.message || '(aucun)'}`,
  ].join('\n');

  try {
    const res = await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        _subject: `Nouvelle réservation confirmée — ${m.eventDate || ''} — BeLux Box`,
        name: m.clientName || 'Client BeLux Box',
        email: session.customer_details?.email || session.customer_email || 'contact@belux-box.com',
        message,
      }),
    });
    if (!res.ok) throw new Error('Formspree a répondu ' + res.status);
    console.log('Email récapitulatif envoyé pour la réservation du', m.eventDate);
  } catch (err) {
    console.error('Échec envoi email récapitulatif:', err.message);
  }
}

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
      await confirmBooking(eventDate, session.id, session);
      console.log('Acompte payé, box confirmée pour le', eventDate, '—', session.metadata.clientName);
    } catch (err) {
      console.error('Erreur confirmation réservation:', err);
    }
    await sendBookingRecapEmail(session);
  }

  res.json({ received: true });
});

// ---------------------------------------------------------------
// ADMIN — liste des réservations, statut acompte/solde.
// ---------------------------------------------------------------
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const all = await getAllBookings();
    const list = [];
    for (const [dateStr, entries] of Object.entries(all)) {
      for (const entry of entries) {
        list.push({ eventDate: dateStr, ...entry });
      }
    }
    // Les plus proches d'abord.
    list.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    res.json({ bookings: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de récupération des réservations' });
  }
});

// Marquer le solde payé / impayé, annuler une réservation, ou ajouter une
// note interne — un seul endpoint, on ne met à jour que les champs fournis.
app.patch('/api/admin/bookings/:date/:sessionId', requireAdmin, express.json(), async (req, res) => {
  try {
    const { date, sessionId } = req.params;
    const { balanceStatus, status, notes } = req.body;
    const fields = {};

    if (balanceStatus !== undefined) {
      if (!['not_due', 'unpaid', 'paid'].includes(balanceStatus)) {
        return res.status(400).json({ error: 'Statut de solde invalide' });
      }
      fields.balanceStatus = balanceStatus;
    }
    if (status !== undefined) {
      if (!['confirmed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Statut invalide' });
      }
      fields.status = status;
    }
    if (notes !== undefined) {
      fields.notes = String(notes).slice(0, 2000);
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Rien à mettre à jour' });
    }

    const ok = await updateBookingFields(date, sessionId, fields);
    if (!ok) return res.status(404).json({ error: 'Réservation introuvable' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de mise à jour' });
  }
});

// ---------------------------------------------------------------
// ADMIN — bloquer / débloquer une date manuellement.
// ---------------------------------------------------------------
app.get('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  try {
    res.json(await getBlockedDates());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de récupération' });
  }
});

app.post('/api/admin/block-date', requireAdmin, express.json(), async (req, res) => {
  try {
    const { date, reason } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date invalide' });
    }
    const blocked = await getBlockedDates();
    blocked[date] = { reason: reason || '', blockedAt: Date.now() };
    await setBlockedDates(blocked);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de blocage' });
  }
});

app.delete('/api/admin/block-date/:date', requireAdmin, async (req, res) => {
  try {
    const blocked = await getBlockedDates();
    delete blocked[req.params.date];
    await setBlockedDates(blocked);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de déblocage' });
  }
});

// ---------------------------------------------------------------
// ADMIN — modifier le tarif de livraison (€/km au-delà de la zone offerte).
// ---------------------------------------------------------------
app.patch('/api/admin/settings', requireAdmin, express.json(), async (req, res) => {
  try {
    const { ratePerKm, freeKm } = req.body;
    const partial = {};
    if (ratePerKm !== undefined) {
      const v = parseFloat(ratePerKm);
      if (isNaN(v) || v < 0) return res.status(400).json({ error: 'ratePerKm invalide' });
      partial.ratePerKm = v;
    }
    if (freeKm !== undefined) {
      const v = parseFloat(freeKm);
      if (isNaN(v) || v < 0) return res.status(400).json({ error: 'freeKm invalide' });
      partial.freeKm = v;
    }
    const updated = await saveSettings(partial);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de mise à jour des réglages' });
  }
});

// ---------------------------------------------------------------
// Prélèvement automatique du SOLDE, 7 jours avant l'événement.
// Déclenché une fois par jour par un service de cron externe (voir
// BRANCHER-STRIPE.txt) qui appelle POST /api/admin/charge-due-balances.
// ---------------------------------------------------------------
async function chargeBalanceForBookingsDueToday() {
  const all = await getAllBookings();
  // On compare deux dates à minuit (sans heure) pour que le calcul soit
  // fiable quelle que soit l'heure à laquelle ce cron tourne dans la journée.
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const results = { charged: [], failed: [], skipped: 0 };

  for (const [dateStr, entries] of Object.entries(all)) {
    const eventDate = new Date(dateStr);
    const daysUntil = Math.round((eventDate - today) / 86400000);
    if (daysUntil !== 7) continue;

    for (const booking of entries) {
      if (booking.status !== 'confirmed' || booking.balanceStatus !== 'unpaid') { results.skipped++; continue; }
      if (!booking.stripeCustomerId || !booking.stripePaymentIntentId) {
        results.failed.push({ ...booking, eventDate: dateStr, reason: 'Pas de moyen de paiement enregistré' });
        continue;
      }
      try {
        const previousIntent = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId);
        await stripe.paymentIntents.create({
          amount: Math.round(parseFloat(booking.balance) * 100),
          currency: 'eur',
          customer: booking.stripeCustomerId,
          payment_method: previousIntent.payment_method,
          off_session: true,
          confirm: true,
          description: 'Solde réservation BeLux Box — ' + booking.formule,
        });
        await setBalanceStatus(dateStr, booking.sessionId, 'paid');
        results.charged.push({ ...booking, eventDate: dateStr });
        console.log('Solde prélevé pour', booking.clientName, dateStr);
      } catch (err) {
        results.failed.push({ ...booking, eventDate: dateStr, reason: err.message });
        console.error('Échec du prélèvement du solde pour', booking.clientName, dateStr, err.message);
      }
    }
  }

  if (results.charged.length > 0 || results.failed.length > 0) {
    await sendBalanceRunSummaryEmail(results);
  }
  return results;
}

async function sendBalanceRunSummaryEmail(results) {
  const lines = [`Prélèvement automatique des soldes (J-7) — résumé du ${new Date().toLocaleDateString('fr-BE')}`, ''];

  if (results.charged.length > 0) {
    lines.push(`✅ Prélevés avec succès (${results.charged.length}) :`);
    results.charged.forEach(b => lines.push(`  - ${b.clientName} — ${b.eventDate} — ${b.balance}€`));
    lines.push('');
  }
  if (results.failed.length > 0) {
    lines.push(`❌ Échecs à traiter manuellement (${results.failed.length}) :`);
    results.failed.forEach(b => lines.push(`  - ${b.clientName} — ${b.eventDate} — ${b.balance}€ — Raison : ${b.reason}`));
    lines.push('');
  }
  lines.push('Un échec (carte refusée, expirée...) n\'annule pas la réservation — contactez le client pour un autre moyen de paiement, puis marquez "Payé" manuellement dans le dashboard une fois réglé.');

  try {
    await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        _subject: `Prélèvement des soldes J-7 — ${results.charged.length} réussi(s), ${results.failed.length} échec(s) — BeLux Box`,
        name: 'BeLux Box (automatique)',
        email: 'contact@belux-box.com',
        message: lines.join('\n'),
      }),
    });
  } catch (err) {
    console.error('Échec envoi email résumé prélèvements:', err.message);
  }
}

app.post('/api/admin/charge-due-balances', requireAdmin, async (req, res) => {
  try {
    const results = await chargeBalanceForBookingsDueToday();
    // Réponse volontairement légère : certains services de cron (dont le
    // plan gratuit de cron-job.org) limitent la taille de la réponse
    // acceptée. Le détail complet part par email (voir sendBalanceRunSummaryEmail),
    // pas la peine de le renvoyer aussi ici.
    res.json({
      success: true,
      charged: results.charged.length,
      failed: results.failed.length,
      skipped: results.skipped,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors du prélèvement des soldes' });
  }
});

// ---------------------------------------------------------------
// Flux ICS — abonnement calendrier (Google Calendar, Apple Calendar,
// Outlook...). L'agenda se resynchronise tout seul régulièrement une
// fois abonné à cette URL, sans rien faire de plus de votre côté.
//
// Sécurité : comme un agenda ne peut pas envoyer d'en-tête personnalisé,
// la clé passe dans l'adresse elle-même (?key=...) plutôt que dans un
// en-tête. Gardez cette URL secrète — quiconque la possède peut voir vos
// réservations (noms, adresses, montants) dans un lecteur de calendrier.
// ---------------------------------------------------------------
function escapeICS(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function dateToICS(dateStr) {
  // "2026-09-24" -> "20260924"
  return dateStr.replace(/-/g, '');
}

function nextDayICS(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

app.get('/api/calendar.ics', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).send('Clé invalide');
  }

  try {
    const allBookings = await getAllBookings();
    const blocked = await getBlockedDates();
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const events = [];

    for (const [dateStr, entries] of Object.entries(allBookings)) {
      for (const b of entries) {
        if (b.status === 'cancelled') continue; // pas dans l'agenda
        const isPending = b.status === 'pending';
        const summary = `📸 BeLux Box — ${b.formule || 'Réservation'} — ${b.clientName || 'Client'}${isPending ? ' (en attente)' : ''}`;
        const description = [
          `Client : ${b.clientName || '—'}`,
          `Email : ${b.email || '—'}`,
          `Téléphone : ${b.phone || '—'}`,
          `Formule : ${b.formule || '—'}`,
          `Total : ${b.total || '—'}€ — Acompte : ${b.deposit || '—'}€ — Solde (${b.balanceStatus || '—'}) : ${b.balance || '—'}€`,
          b.notes ? `Notes : ${b.notes}` : '',
        ].filter(Boolean).join('\n');

        events.push([
          'BEGIN:VEVENT',
          `UID:booking-${b.sessionId}@belux-box.com`,
          `DTSTAMP:${now}`,
          `DTSTART;VALUE=DATE:${dateToICS(dateStr)}`,
          `DTEND;VALUE=DATE:${nextDayICS(dateStr)}`,
          `SUMMARY:${escapeICS(summary)}`,
          `DESCRIPTION:${escapeICS(description)}`,
          `LOCATION:${escapeICS(b.address || '')}`,
          `STATUS:${isPending ? 'TENTATIVE' : 'CONFIRMED'}`,
          'END:VEVENT',
        ].join('\r\n'));
      }
    }

    for (const [dateStr, info] of Object.entries(blocked)) {
      events.push([
        'BEGIN:VEVENT',
        `UID:blocked-${dateStr}@belux-box.com`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${dateToICS(dateStr)}`,
        `DTEND;VALUE=DATE:${nextDayICS(dateStr)}`,
        `SUMMARY:${escapeICS('🚫 BeLux Box — Date bloquée' + (info.reason ? ' — ' + info.reason : ''))}`,
        'STATUS:CONFIRMED',
        'END:VEVENT',
      ].join('\r\n'));
    }

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BeLux Box//Reservations//FR',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:BeLux Box — Réservations',
      'X-WR-TIMEZONE:Europe/Brussels',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="belux-box.ics"');
    res.send(ics);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur de génération du calendrier');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('BeLux Box payment server running on port ' + PORT));
