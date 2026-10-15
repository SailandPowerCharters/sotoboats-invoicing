require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({ pool, tableName: 'sotoboats_invoice_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'replace-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

const esc = (v = '') => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const minor = (v) => Math.round(Number(v || 0) * 100);
const major = (v) => Number(v || 0) / 100;
const euro = (v) => `€${major(v).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateYmd = (v) => {
  if (!v) return '';

  // Native PostgreSQL DATE strings.
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // pg may return DATE values as JavaScript Date objects.
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const fmtDate = (v) => {
  const ymd = dateYmd(v);
  if (!ymd) return '—';
  const [yyyy, mm, dd] = ymd.split('-');
  return `${dd}/${mm}/${yyyy}`;
};

const iso = (v) => dateYmd(v);

async function getTenant(client = pool) {
  const { rows } = await client.query(`SELECT * FROM invoice_tenants WHERE code='SOTOBOATS' LIMIT 1`);
  if (!rows[0]) throw new Error('Sotoboats tenant is missing. Database startup initialisation did not complete.');
  return rows[0];
}

async function refreshOverdueStatuses(tenantId) {
  await pool.query(`
    UPDATE customer_invoices
    SET status='overdue', updated_at=now()
    WHERE tenant_id=$1
      AND locked_at IS NOT NULL
      AND outstanding_minor > 0
      AND due_date IS NOT NULL
      AND due_date < CURRENT_DATE
      AND status NOT IN ('paid','cancelled','credited','overdue')
  `,[tenantId]);

  await pool.query(`
    UPDATE customer_invoices
    SET status=CASE WHEN paid_minor > 0 THEN 'part_paid' ELSE 'sent' END, updated_at=now()
    WHERE tenant_id=$1
      AND status='overdue'
      AND outstanding_minor > 0
      AND due_date IS NOT NULL
      AND due_date >= CURRENT_DATE
  `,[tenantId]);
}

function statusPill(status) {
  const s = String(status || '').toLowerCase();
  const cls = ['paid'].includes(s) ? 'green' : ['overdue','cancelled'].includes(s) ? 'red' : ['sent','part_paid'].includes(s) ? 'amber' : '';
  return `<span class="pill ${cls}">${esc(String(status || 'draft').replaceAll('_',' '))}</span>`;
}

function requireAuth(req, res, next) {
  if (req.session?.sotoboatsInvoiceAuthed) return next();
  res.redirect('/login');
}

async function recalcInvoice(client, invoiceId) {
  const items = (await client.query(`SELECT * FROM customer_invoice_items WHERE invoice_id=$1 ORDER BY sort_order`, [invoiceId])).rows;
  const subtotal = items.reduce((s,i)=>s+Number(i.line_net_minor),0);
  const tax = items.reduce((s,i)=>s+Number(i.line_tax_minor),0);
  const total = items.reduce((s,i)=>s+Number(i.line_total_minor),0);
  const inv = (await client.query(`SELECT * FROM customer_invoices WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
  const paid = Number(inv?.paid_minor || 0);
  await client.query(`UPDATE customer_invoices SET subtotal_minor=$1,tax_minor=$2,total_minor=$3,outstanding_minor=$4,updated_at=now() WHERE id=$5`,
    [subtotal,tax,total,Math.max(0,total-paid),invoiceId]);
}

function calculateLine(quantity, unitPrice, taxRate) {
  const qty = Number(quantity || 0);
  const unit = minor(unitPrice);
  const net = Math.round(qty * unit);
  const tax = Math.round(net * (Number(taxRate || 0) / 100));
  return { qty, unit, net, tax, total: net + tax };
}

async function loadInvoice(id) {
  const tenant = await getTenant();
  const invoice = (await pool.query(`
    SELECT i.*,
           COALESCE(i.snapshot_contact_name,c.contact_name) AS contact_name,
           COALESCE(i.snapshot_company_name,c.company_name) AS company_name,
           COALESCE(i.snapshot_email,c.email) AS email,
           COALESCE(i.snapshot_phone,c.phone) AS phone,
           COALESCE(i.snapshot_billing_address_1,c.billing_address_1) AS billing_address_1,
           COALESCE(i.snapshot_billing_address_2,c.billing_address_2) AS billing_address_2,
           COALESCE(i.snapshot_billing_city,c.billing_city) AS billing_city,
           COALESCE(i.snapshot_billing_region,c.billing_region) AS billing_region,
           COALESCE(i.snapshot_billing_postcode,c.billing_postcode) AS billing_postcode,
           COALESCE(i.snapshot_billing_country_code,c.billing_country_code) AS billing_country_code,
           COALESCE(i.snapshot_tax_number,c.tax_number) AS tax_number,
           COALESCE(i.snapshot_identity_type,c.identity_type) AS identity_type,
           COALESCE(i.snapshot_identity_number,c.identity_number) AS identity_number
    FROM customer_invoices i
    JOIN invoice_customers c ON c.id=i.customer_id
    WHERE i.id=$1 AND i.tenant_id=$2
  `,[id,tenant.id])).rows[0];
  if (!invoice) return null;
  const [items,payments,events] = await Promise.all([
    pool.query(`SELECT * FROM customer_invoice_items WHERE invoice_id=$1 ORDER BY sort_order`,[id]),
    pool.query(`SELECT * FROM customer_invoice_payments WHERE invoice_id=$1 ORDER BY paid_at,created_at`,[id]),
    pool.query(`SELECT * FROM customer_invoice_events WHERE invoice_id=$1 ORDER BY created_at DESC`,[id])
  ]);
  return { tenant, invoice, items:items.rows, payments:payments.rows, events:events.rows };
}


async function loadCreditNote(id) {
  const tenant=await getTenant();
  const note=(await pool.query(`
    SELECT cn.*,
      COALESCE(cn.snapshot_contact_name,c.contact_name) AS contact_name,
      COALESCE(cn.snapshot_company_name,c.company_name) AS company_name,
      COALESCE(cn.snapshot_email,c.email) AS email,
      COALESCE(cn.snapshot_phone,c.phone) AS phone,
      COALESCE(cn.snapshot_billing_address_1,c.billing_address_1) AS billing_address_1,
      COALESCE(cn.snapshot_billing_address_2,c.billing_address_2) AS billing_address_2,
      COALESCE(cn.snapshot_billing_city,c.billing_city) AS billing_city,
      COALESCE(cn.snapshot_billing_region,c.billing_region) AS billing_region,
      COALESCE(cn.snapshot_billing_postcode,c.billing_postcode) AS billing_postcode,
      COALESCE(cn.snapshot_billing_country_code,c.billing_country_code) AS billing_country_code,
      COALESCE(cn.snapshot_tax_number,c.tax_number) AS tax_number,
      COALESCE(cn.snapshot_identity_type,c.identity_type) AS identity_type,
      COALESCE(cn.snapshot_identity_number,c.identity_number) AS identity_number,
      inv.invoice_number AS original_invoice_number,
      inv.total_minor AS original_invoice_total_minor,
      inv.paid_minor AS original_invoice_paid_minor,
      inv.credited_minor AS original_invoice_credited_minor
    FROM customer_credit_notes cn
    JOIN invoice_customers c ON c.id=cn.customer_id
    JOIN customer_invoices inv ON inv.id=cn.original_invoice_id
    WHERE cn.id=$1 AND cn.tenant_id=$2
  `,[id,tenant.id])).rows[0];
  if(!note) return null;
  const items=(await pool.query(`SELECT * FROM customer_credit_note_items WHERE credit_note_id=$1 ORDER BY sort_order`,[id])).rows;
  return {tenant,note,items};
}

async function issuedCreditsForInvoice(invoiceId, excludeCreditNoteId=null, client=pool) {
  const params=[invoiceId];
  let where=`original_invoice_id=$1 AND status='issued'`;
  if(excludeCreditNoteId){
    params.push(excludeCreditNoteId);
    where+=` AND id<>$2`;
  }
  const r=await client.query(`SELECT COALESCE(SUM(total_minor),0)::bigint n FROM customer_credit_notes WHERE ${where}`,params);
  return Number(r.rows[0].n||0);
}

function creditStatusPill(status) {
  const cls=status==='issued'?'green':status==='cancelled'?'red':'';
  return `<span class="pill ${cls}">${esc(status||'draft')}</span>`;
}


function normaliseMonth(value) {
  const s=String(value||'').trim();
  return /^\d{4}-\d{2}$/.test(s)?s:'';
}

function monthBounds(month) {
  const m=normaliseMonth(month);
  if(!m) return null;
  const [y,mo]=m.split('-').map(Number);
  const start=`${y}-${String(mo).padStart(2,'0')}-01`;
  const nextMo=mo===12?1:mo+1;
  const nextY=mo===12?y+1:y;
  const end=`${nextY}-${String(nextMo).padStart(2,'0')}-01`;
  return {start,end};
}

function monthLabel(month) {
  const b=monthBounds(month);
  if(!b) return '';
  const [y,m]=month.split('-').map(Number);
  const d=new Date(Date.UTC(y,m-1,1));
  return d.toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
}

function csvEscape(v) {
  const s=String(v??'');
  return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}

async function monthEndIncomeRows(tenantId, month) {
  const b=monthBounds(month);
  if(!b) return [];
  return (await pool.query(`
    SELECT
      i.id AS invoice_id,
      i.invoice_number,
      i.issue_date,
      i.due_date,
      i.subtotal_minor,
      i.tax_minor,
      i.total_minor,
      i.paid_minor,
      i.credited_minor,
      i.outstanding_minor,
      i.status,
      COALESCE(i.snapshot_contact_name,c.contact_name) AS contact_name,
      COALESCE(i.snapshot_company_name,c.company_name) AS company_name,
      COALESCE(i.snapshot_email,c.email) AS email,
      SUM(p.amount_minor)::bigint AS received_in_month_minor,
      MIN(p.paid_at) AS first_payment_in_month,
      MAX(p.paid_at) AS last_payment_in_month,
      STRING_AGG(DISTINCT p.method, ', ' ORDER BY p.method) AS payment_methods,
      STRING_AGG(DISTINCT COALESCE(NULLIF(p.reference,''),'—'), ', ') AS payment_references
    FROM customer_invoice_payments p
    JOIN customer_invoices i ON i.id=p.invoice_id
    JOIN invoice_customers c ON c.id=i.customer_id
    WHERE p.tenant_id=$1
      AND p.paid_at >= $2::date
      AND p.paid_at < $3::date
    GROUP BY
      i.id,i.invoice_number,i.issue_date,i.due_date,i.subtotal_minor,i.tax_minor,i.total_minor,
      i.paid_minor,i.credited_minor,i.outstanding_minor,i.status,
      i.snapshot_contact_name,c.contact_name,i.snapshot_company_name,c.company_name,
      i.snapshot_email,c.email
    ORDER BY MIN(p.paid_at),i.invoice_number
  `,[tenantId,b.start,b.end])).rows;
}

async function monthEndCreditRows(tenantId, month) {
  const b=monthBounds(month);
  if(!b) return [];
  return (await pool.query(`
    SELECT
      cn.id AS credit_note_id,
      cn.credit_note_number,
      cn.issue_date,
      cn.reason,
      cn.subtotal_minor,
      cn.tax_minor,
      cn.total_minor,
      i.invoice_number AS original_invoice_number,
      COALESCE(cn.snapshot_contact_name,c.contact_name) AS contact_name,
      COALESCE(cn.snapshot_company_name,c.company_name) AS company_name
    FROM customer_credit_notes cn
    JOIN customer_invoices i ON i.id=cn.original_invoice_id
    JOIN invoice_customers c ON c.id=cn.customer_id
    WHERE cn.tenant_id=$1
      AND cn.status='issued'
      AND cn.issue_date >= $2::date
      AND cn.issue_date < $3::date
    ORDER BY cn.issue_date,cn.credit_note_number
  `,[tenantId,b.start,b.end])).rows;
}

function monthEndIncomeCsv(rows, month) {
  const header=[
    'Month','Invoice Number','Customer','Email','Invoice Date','Due Date',
    'Invoice Net','Invoice VAT','Invoice Total','Received In Selected Month',
    'First Payment Date','Last Payment Date','Payment Method(s)','Payment Reference(s)',
    'Total Paid To Date','Credits To Date','Outstanding Balance','Status'
  ];
  const data=rows.map(r=>[
    monthLabel(month),
    r.invoice_number||'',
    r.company_name||r.contact_name||'',
    r.email||'',
    fmtDate(r.issue_date),
    fmtDate(r.due_date),
    major(r.subtotal_minor).toFixed(2),
    major(r.tax_minor).toFixed(2),
    major(r.total_minor).toFixed(2),
    major(r.received_in_month_minor).toFixed(2),
    fmtDate(r.first_payment_in_month),
    fmtDate(r.last_payment_in_month),
    r.payment_methods||'',
    r.payment_references||'',
    major(r.paid_minor).toFixed(2),
    major(r.credited_minor||0).toFixed(2),
    major(r.outstanding_minor).toFixed(2),
    r.status||''
  ]);
  return [header,...data].map(row=>row.map(csvEscape).join(',')).join('\n');
}

function monthEndCreditsCsv(rows, month) {
  const header=['Month','Credit Note','Original Invoice','Customer','Issue Date','Reason','Net Credit','VAT Credit','Total Credit'];
  const data=rows.map(r=>[
    monthLabel(month),
    r.credit_note_number||'',
    r.original_invoice_number||'',
    r.company_name||r.contact_name||'',
    fmtDate(r.issue_date),
    r.reason||'',
    major(r.subtotal_minor).toFixed(2),
    major(r.tax_minor).toFixed(2),
    major(r.total_minor).toFixed(2)
  ]);
  return [header,...data].map(row=>row.map(csvEscape).join(',')).join('\n');
}

const nav = (active) => `
  <aside class="side">
    <div class="brand"><span class="mark">S</span><div><strong>SOTOBOATS</strong><small>INVOICING · YDP PILOT</small></div></div>
    <nav>
      <a class="${active==='dashboard'?'active':''}" href="/">Dashboard</a>
      <a class="${active==='invoices'?'active':''}" href="/invoices">Invoices</a>
      <a class="${active==='credit-notes'?'active':''}" href="/credit-notes">Credit Notes</a>
      <a class="${active==='month-end'?'active':''}" href="/month-end">Month End</a>
      <a class="${active==='customers'?'active':''}" href="/customers">Customers</a>
      <a class="${active==='settings'?'active':''}" href="/settings">Company Settings</a>
    </nav>
    <div class="side-foot">Marbella Sailing School S.L.<br>trading as Sotoboats<br><br><a href="/logout">Sign out →</a></div>
  </aside>`;

function shell(title, active, content, subtitle='') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} | Sotoboats Invoicing</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Playfair+Display:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .line-row{align-items:end}
    .line-row .preset-bar{
      grid-column:1 / -1;
      display:grid;
      grid-template-columns:minmax(260px,1.5fr) 110px minmax(150px,1fr) minmax(150px,1fr);
      gap:10px;
      padding:10px 12px;
      margin:-2px 0 2px;
      border:1px solid #e1e8eb;
      border-radius:10px;
      background:#f7fafb;
    }
    .preset-bar .hours-wrap,.preset-bar .from-wrap,.preset-bar .to-wrap{display:none}
    .preset-bar.show-hours .hours-wrap{display:grid}
    .preset-bar.show-route .from-wrap,.preset-bar.show-route .to-wrap{display:grid}
    @media(max-width:1100px){
      .line-row .preset-bar{grid-template-columns:1fr 100px}
      .preset-bar.show-route{grid-template-columns:1fr 1fr}
      .preset-bar.show-route label:first-child{grid-column:1/-1}
    }
    @media(max-width:760px){
      .line-row .preset-bar{grid-template-columns:1fr}
      .preset-bar.show-route{grid-template-columns:1fr}
      .preset-bar.show-route label:first-child{grid-column:auto}
    }
  </style></head><body><div class="layout">${nav(active)}<main class="main">
  <div class="top"><div><div class="eyebrow">Sotoboats · Your Dispatch Partner pilot</div><h1>${esc(title)}</h1>${subtitle?`<p class="sub">${esc(subtitle)}</p>`:''}</div></div>${content}</main></div></body></html>`;
}

app.get('/login',(req,res)=>{
  if(req.session?.sotoboatsInvoiceAuthed) return res.redirect('/');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sotoboats Invoicing Login</title><link rel="stylesheet" href="/styles.css"></head><body class="login-page"><form class="login-card" method="post" action="/login"><span class="mark">S</span><div class="eyebrow">SOTOBOATS</div><h1>Invoicing</h1><p class="sub">Marbella Sailing School S.L. · YDP pilot</p>${req.query.error?'<div class="error">Login details were not recognised.</div>':''}<label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" required></label><button class="btn gold" type="submit">Enter invoicing →</button></form></body></html>`);
});
app.post('/login',(req,res)=>{
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMeNow!';
  if(req.body.email===email && req.body.password===password){
    req.session.sotoboatsInvoiceAuthed=true;
    return req.session.save(()=>res.redirect('/'));
  }
  res.redirect('/login?error=1');
});
app.get('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/login')));
app.use(requireAuth);

app.get('/', async (req,res)=>{
  const tenant=await getTenant();
  const [counts,total,paid,outstanding,recent]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int n FROM customer_invoices WHERE tenant_id=$1`,[tenant.id]),
    pool.query(`SELECT COALESCE(SUM(total_minor),0)::bigint n FROM customer_invoices WHERE tenant_id=$1 AND status<>'cancelled'`,[tenant.id]),
    pool.query(`SELECT COALESCE(SUM(paid_minor),0)::bigint n FROM customer_invoices WHERE tenant_id=$1 AND status<>'cancelled'`,[tenant.id]),
    pool.query(`SELECT COALESCE(SUM(outstanding_minor),0)::bigint n FROM customer_invoices WHERE tenant_id=$1 AND status IN ('sent','part_paid','overdue')`,[tenant.id]),
    pool.query(`SELECT i.*,c.contact_name,c.company_name FROM customer_invoices i JOIN invoice_customers c ON c.id=i.customer_id WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT 8`,[tenant.id])
  ]);
  const table=recent.rows.length?`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Due now</th><th>Status</th><th></th></tr></thead><tbody>${recent.rows.map(r=>`<tr><td><strong>${esc(r.invoice_number||'Draft')}</strong><br><span class="muted">${fmtDate(r.created_at)}</span></td><td>${esc(r.company_name||r.contact_name)}</td><td>${euro(r.total_minor)}</td><td>${euro(r.amount_due_now_minor??r.outstanding_minor)}</td><td>${statusPill(r.status)}</td><td><a class="btn light" href="/invoices/${r.id}">Open</a></td></tr>`).join('')}</tbody></table></div>`:'<p class="sub">No invoices yet.</p>';
  const content=`<div class="metrics"><div class="metric"><small>Invoices</small><strong>${counts.rows[0].n}</strong></div><div class="metric"><small>Invoiced</small><strong>${euro(total.rows[0].n)}</strong></div><div class="metric"><small>Paid</small><strong>${euro(paid.rows[0].n)}</strong></div><div class="metric"><small>Outstanding</small><strong>${euro(outstanding.rows[0].n)}</strong></div></div><section class="card"><div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Recent invoices</h2><a class="btn gold" href="/invoices/new">Create invoice</a></div>${table}</section>`;
  res.send(shell('Invoice Dashboard','dashboard',content,'Dave’s live test of the future YDP invoicing engine.'));
});

function customerForm(c={}, action='/customers', heading='New customer') {
  return `<section class="form-card"><div class="actions" style="justify-content:space-between"><div><h2>${esc(heading)}</h2><p class="sub">Draft invoices use the live customer record. Issued invoices keep the customer details that were present when issued.</p></div>${c.id?'<a class="btn light" href="/customers">Back to customers</a>':''}</div>
  <form method="post" action="${action}"><div class="form-grid">
    <label>Customer type<select name="customer_type"><option value="individual" ${c.customer_type!=='business'?'selected':''}>Individual</option><option value="business" ${c.customer_type==='business'?'selected':''}>Business</option></select></label>
    <label>Contact name<input name="contact_name" value="${esc(c.contact_name||'')}" required></label>
    <label>Company name<input name="company_name" value="${esc(c.company_name||'')}"></label>
    <label>Email<input type="email" name="email" value="${esc(c.email||'')}"></label>
    <label>Phone<input name="phone" value="${esc(c.phone||'')}"></label>
    <label>Tax / VAT number<input name="tax_number" value="${esc(c.tax_number||'')}"></label>
    <label>Address<input name="billing_address_1" value="${esc(c.billing_address_1||'')}"></label>
    <label>Address line 2<input name="billing_address_2" value="${esc(c.billing_address_2||'')}"></label>
    <label>Town / City<input name="billing_city" value="${esc(c.billing_city||'')}"></label>
    <label>Region<input name="billing_region" value="${esc(c.billing_region||'')}"></label>
    <label>Postcode<input name="billing_postcode" value="${esc(c.billing_postcode||'')}"></label>
    <label>Country code<input name="billing_country_code" value="${esc(c.billing_country_code||'ES')}" maxlength="2"></label>
    <label>Passport / ID type<input name="identity_type" value="${esc(c.identity_type||'')}" placeholder="Optional"></label>
    <label>Passport / ID number<input name="identity_number" value="${esc(c.identity_number||'')}" placeholder="Optional"></label>
    <label class="full">Internal notes<textarea name="notes">${esc(c.notes||'')}</textarea></label>
  </div><div class="actions"><button class="btn gold">Save customer</button></div></form></section>`;
}

function customerValues(b){
  return [
    b.customer_type||'individual',
    b.company_name||null,
    b.contact_name,
    b.email||null,
    b.phone||null,
    b.billing_address_1||null,
    b.billing_address_2||null,
    b.billing_city||null,
    b.billing_region||null,
    b.billing_postcode||null,
    (b.billing_country_code||'ES').toUpperCase().slice(0,2),
    b.tax_number||null,
    b.identity_type||null,
    b.identity_number||null,
    b.notes||null
  ];
}

app.get('/customers',async(req,res)=>{
  const tenant=await getTenant();
  const rows=(await pool.query(`SELECT * FROM invoice_customers WHERE tenant_id=$1 AND is_active=true ORDER BY COALESCE(company_name,contact_name),contact_name`,[tenant.id])).rows;
  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th>Address</th><th>Tax / ID</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.company_name||r.contact_name)}</strong>${r.company_name?`<br><span class="muted">${esc(r.contact_name||'')}</span>`:''}</td><td>${esc(r.email||'—')}</td><td>${esc(r.phone||'—')}</td><td>${esc([r.billing_address_1,r.billing_city,r.billing_postcode].filter(Boolean).join(', ')||'—')}</td><td>${esc(r.tax_number||r.identity_number||'—')}</td><td><a class="btn light" href="/customers/${r.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table></div>`:'<p class="sub">No customers yet.</p>';
  const content=`
    <div class="actions" style="margin-bottom:14px"><a class="btn gold" href="#new">Add customer</a><a class="btn light" href="/customers/import">Import CSV</a><a class="btn light" href="/customers/template.csv">Download CSV template</a></div>
    <section id="new">${customerForm({},'/customers','New customer')}</section>
    <section class="card"><h2>Customers</h2>${table}</section>`;
  res.send(shell('Customers','customers',content,'Reusable customer records for future invoices.'));
});

app.post('/customers',async(req,res)=>{
  const tenant=await getTenant();
  const b=req.body;
  if(!String(b.contact_name||'').trim()) return res.status(400).send('Contact name is required.');
  const v=customerValues(b);
  await pool.query(`
    INSERT INTO invoice_customers(
      tenant_id,customer_type,company_name,contact_name,email,phone,billing_address_1,billing_address_2,
      billing_city,billing_region,billing_postcode,billing_country_code,tax_number,identity_type,identity_number,notes
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  `,[tenant.id,...v]);
  res.redirect('/customers');
});

app.get('/customers/:id/edit',async(req,res)=>{
  const tenant=await getTenant();
  const c=(await pool.query(`SELECT * FROM invoice_customers WHERE id=$1 AND tenant_id=$2 AND is_active=true`,[req.params.id,tenant.id])).rows[0];
  if(!c) return res.status(404).send('Customer not found.');
  res.send(shell('Edit Customer','customers',customerForm(c,`/customers/${c.id}/edit`,'Edit customer'),'Changes flow through to draft invoices only. Issued invoices remain unchanged.'));
});

app.post('/customers/:id/edit',async(req,res)=>{
  const tenant=await getTenant();
  const b=req.body;
  if(!String(b.contact_name||'').trim()) return res.status(400).send('Contact name is required.');
  const v=customerValues(b);
  await pool.query(`
    UPDATE invoice_customers SET
      customer_type=$1,company_name=$2,contact_name=$3,email=$4,phone=$5,
      billing_address_1=$6,billing_address_2=$7,billing_city=$8,billing_region=$9,
      billing_postcode=$10,billing_country_code=$11,tax_number=$12,identity_type=$13,
      identity_number=$14,notes=$15,updated_at=now()
    WHERE id=$16 AND tenant_id=$17
  `,[...v,req.params.id,tenant.id]);
  res.redirect('/customers');
});

app.get('/customers/template.csv',(req,res)=>{
  const csv=[
    'Customer Type,Contact Name,Company Name,Email,Phone,Address 1,Address 2,City,Region,Postcode,Country Code,Tax VAT Number,ID Type,ID Number,Notes',
    'individual,Jane Example,,jane@example.com,+34600000000,Calle Example 1,,Estepona,Málaga,29680,ES,,Passport,123456789,'
  ].join('\\n');
  res.type('text/csv');
  res.setHeader('Content-Disposition','attachment; filename="Sotoboats-Customer-Import-Template.csv"');
  res.send(csv);
});

app.get('/customers/import',async(req,res)=>{
  const content=`<section class="card">
    <h2>Import customers from CSV</h2>
    <p class="sub">Upload a CSV, map its columns to customer fields, preview the data, then import. Nothing is added until you press Import customers.</p>
    <div class="form-grid" style="margin-top:16px">
      <label>CSV file<input id="csvFile" type="file" accept=".csv,text/csv"></label>
      <label>Duplicates<select id="duplicateMode"><option value="skip">Skip matching email / phone</option><option value="update">Update matching email / phone</option><option value="new">Always import as new</option></select></label>
    </div>
    <div id="mappingArea" style="margin-top:18px"></div>
    <div id="previewArea" style="margin-top:18px"></div>
    <div class="actions"><button id="importBtn" class="btn gold" type="button" disabled>Import customers</button><a class="btn light" href="/customers/template.csv">Download template</a><a class="btn light" href="/customers">Cancel</a></div>
    <div id="importResult" style="margin-top:14px"></div>
  </section>
  <script>
  (function(){
    const fieldOptions=[
      ['','Do not import'],['customer_type','Customer Type'],['contact_name','Contact Name'],['company_name','Company Name'],
      ['email','Email'],['phone','Phone'],['billing_address_1','Address 1'],['billing_address_2','Address 2'],
      ['billing_city','City'],['billing_region','Region'],['billing_postcode','Postcode'],
      ['billing_country_code','Country Code'],['tax_number','Tax / VAT Number'],['identity_type','ID Type'],
      ['identity_number','ID Number'],['notes','Notes']
    ];
    const aliases={
      'customer type':'customer_type','type':'customer_type','contact name':'contact_name','name':'contact_name',
      'customer name':'contact_name','company name':'company_name','company':'company_name','email':'email',
      'email address':'email','phone':'phone','telephone':'phone','mobile':'phone','address 1':'billing_address_1',
      'address':'billing_address_1','address line 1':'billing_address_1','address 2':'billing_address_2',
      'address line 2':'billing_address_2','city':'billing_city','town':'billing_city','region':'billing_region',
      'province':'billing_region','postcode':'billing_postcode','postal code':'billing_postcode','zip':'billing_postcode',
      'country code':'billing_country_code','country':'billing_country_code','tax vat number':'tax_number',
      'tax number':'tax_number','vat number':'tax_number','id type':'identity_type','passport id type':'identity_type',
      'id number':'identity_number','passport number':'identity_number','passport id number':'identity_number','notes':'notes'
    };
    let matrix=[],headers=[];

    function parseCSV(text){
      const rows=[]; let row=[],cell='',quoted=false;
      for(let i=0;i<text.length;i++){
        const ch=text[i], next=text[i+1];
        if(ch==='"'){
          if(quoted && next==='"'){cell+='"';i++;}
          else quoted=!quoted;
        }else if(ch===',' && !quoted){row.push(cell);cell='';}
        else if((ch==='\\n'||ch==='\\r') && !quoted){
          if(ch==='\\r'&&next==='\\n') i++;
          row.push(cell);cell='';
          if(row.some(v=>String(v).trim()!=='')) rows.push(row);
          row=[];
        }else cell+=ch;
      }
      row.push(cell);
      if(row.some(v=>String(v).trim()!=='')) rows.push(row);
      return rows;
    }
    function norm(v){return String(v||'').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\\s+/g,' ');}
    function renderMapping(){
      const html='<h3>Map columns</h3><div class="table-wrap"><table><thead><tr><th>CSV column</th><th>Import as</th><th>Example</th></tr></thead><tbody>'+
      headers.map((h,i)=>{
        const guess=aliases[norm(h)]||'';
        return '<tr><td><strong>'+escapeHtml(h)+'</strong></td><td><select class="mapSelect" data-index="'+i+'">'+
          fieldOptions.map(o=>'<option value="'+o[0]+'" '+(o[0]===guess?'selected':'')+'>'+o[1]+'</option>').join('')+
          '</select></td><td>'+escapeHtml((matrix[1]&&matrix[1][i])||'')+'</td></tr>';
      }).join('')+'</tbody></table></div>';
      document.getElementById('mappingArea').innerHTML=html;
      document.querySelectorAll('.mapSelect').forEach(s=>s.addEventListener('change',renderPreview));
      renderPreview();
    }
    function mappedRows(){
      const maps=Array.from(document.querySelectorAll('.mapSelect')).map(s=>s.value);
      return matrix.slice(1).map(r=>{
        const o={};
        maps.forEach((field,i)=>{if(field)o[field]=String(r[i]||'').trim();});
        if(o.billing_country_code && o.billing_country_code.length>2){
          const c=o.billing_country_code.toLowerCase();
          if(c==='spain'||c==='españa') o.billing_country_code='ES';
          else if(c==='united kingdom'||c==='uk'||c==='great britain') o.billing_country_code='GB';
        }
        return o;
      }).filter(o=>Object.values(o).some(v=>v));
    }
    function renderPreview(){
      const rows=mappedRows();
      const first=rows.slice(0,8);
      document.getElementById('previewArea').innerHTML='<h3>Preview</h3><p class="sub">'+rows.length+' row(s) ready to import.</p>'+
        (first.length?'<div class="table-wrap"><table><thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>City</th></tr></thead><tbody>'+
        first.map(r=>'<tr><td>'+escapeHtml(r.contact_name||'')+'</td><td>'+escapeHtml(r.company_name||'')+'</td><td>'+escapeHtml(r.email||'')+'</td><td>'+escapeHtml(r.phone||'')+'</td><td>'+escapeHtml(r.billing_city||'')+'</td></tr>').join('')+
        '</tbody></table></div>':'');
      document.getElementById('importBtn').disabled=!rows.length;
    }
    function escapeHtml(v){return String(v||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});}

    document.getElementById('csvFile').addEventListener('change',function(){
      const file=this.files[0]; if(!file)return;
      const reader=new FileReader();
      reader.onload=function(){
        matrix=parseCSV(String(reader.result||'').replace(/^\\uFEFF/,''));
        if(matrix.length<2){document.getElementById('mappingArea').innerHTML='<div class="error">No data rows found.</div>';return;}
        headers=matrix[0].map(v=>String(v||'').trim());
        renderMapping();
      };
      reader.readAsText(file);
    });

    document.getElementById('importBtn').addEventListener('click',async function(){
      const rows=mappedRows();
      if(!rows.length)return;
      if(rows.some(r=>!r.contact_name)){
        document.getElementById('importResult').innerHTML='<div class="error">Every imported row needs a Contact Name. Map a name column before importing.</div>';
        return;
      }
      this.disabled=true; this.textContent='Importing…';
      try{
        const response=await fetch('/customers/import',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({rows:rows,duplicate_mode:document.getElementById('duplicateMode').value})
        });
        const data=await response.json();
        if(!response.ok) throw new Error(data.error||'Import failed');
        document.getElementById('importResult').innerHTML='<div class="card" style="background:#f2fbef"><strong>Import complete</strong><p class="sub">'+data.imported+' imported · '+data.updated+' updated · '+data.skipped+' skipped · '+data.errors+' errors</p></div>';
      }catch(err){
        document.getElementById('importResult').innerHTML='<div class="error">'+escapeHtml(err.message)+'</div>';
      }finally{
        this.disabled=false; this.textContent='Import customers';
      }
    });
  })();
  </script>`;
  res.send(shell('Import Customers','customers',content,'Bring existing customer records into Sotoboats invoicing.'));
});

app.post('/customers/import',async(req,res)=>{
  const tenant=await getTenant();
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  const mode=req.body.duplicate_mode||'skip';
  let imported=0,updated=0,skipped=0,errors=0;

  for(const raw of rows){
    const b=raw||{};
    if(!String(b.contact_name||'').trim()){errors++;continue;}
    try{
      let existing=null;
      if(mode!=='new' && b.email){
        existing=(await pool.query(`SELECT * FROM invoice_customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) AND is_active=true LIMIT 1`,[tenant.id,b.email])).rows[0]||null;
      }
      if(!existing && mode!=='new' && b.phone){
        existing=(await pool.query(`SELECT * FROM invoice_customers WHERE tenant_id=$1 AND phone=$2 AND is_active=true LIMIT 1`,[tenant.id,b.phone])).rows[0]||null;
      }
      if(existing && mode==='skip'){skipped++;continue;}

      const v=customerValues(b);
      if(existing && mode==='update'){
        await pool.query(`
          UPDATE invoice_customers SET customer_type=$1,company_name=$2,contact_name=$3,email=$4,phone=$5,
          billing_address_1=$6,billing_address_2=$7,billing_city=$8,billing_region=$9,billing_postcode=$10,
          billing_country_code=$11,tax_number=$12,identity_type=$13,identity_number=$14,notes=$15,updated_at=now()
          WHERE id=$16 AND tenant_id=$17
        `,[...v,existing.id,tenant.id]);
        updated++;
      }else{
        await pool.query(`
          INSERT INTO invoice_customers(
            tenant_id,customer_type,company_name,contact_name,email,phone,billing_address_1,billing_address_2,
            billing_city,billing_region,billing_postcode,billing_country_code,tax_number,identity_type,identity_number,notes
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `,[tenant.id,...v]);
        imported++;
      }
    }catch(err){
      console.error('Customer import row failed',err);
      errors++;
    }
  }
  res.json({ok:true,imported,updated,skipped,errors});
});

app.get('/invoices',async(req,res)=>{
  const tenant=await getTenant();
  await refreshOverdueStatuses(tenant.id);

  const q=String(req.query.q||'').trim();
  const filter=String(req.query.filter||'all');
  const params=[tenant.id];
  let where=`i.tenant_id=$1`;

  if(q){
    params.push(`%${q}%`);
    const p=params.length;
    where+=` AND (
      COALESCE(i.invoice_number,'') ILIKE $${p}
      OR COALESCE(c.contact_name,'') ILIKE $${p}
      OR COALESCE(c.company_name,'') ILIKE $${p}
      OR COALESCE(c.email,'') ILIKE $${p}
    )`;
  }

  if(filter==='draft') where+=` AND i.locked_at IS NULL`;
  if(filter==='due') where+=` AND i.locked_at IS NOT NULL AND i.outstanding_minor>0 AND (i.due_date IS NULL OR i.due_date>=CURRENT_DATE)`;
  if(filter==='overdue') where+=` AND i.locked_at IS NOT NULL AND i.outstanding_minor>0 AND i.due_date<CURRENT_DATE`;
  if(filter==='paid') where+=` AND i.status='paid'`;
  if(filter==='part_paid') where+=` AND i.status='part_paid'`;

  const rows=(await pool.query(`
    SELECT i.*,c.contact_name,c.company_name,c.email
    FROM customer_invoices i
    JOIN invoice_customers c ON c.id=i.customer_id
    WHERE ${where}
    ORDER BY
      CASE WHEN i.status='overdue' THEN 0 ELSE 1 END,
      COALESCE(i.due_date,i.created_at::date) ASC,
      i.created_at DESC
  `,params)).rows;

  const counts=(await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE locked_at IS NULL)::int AS drafts,
      COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND outstanding_minor>0 AND (due_date IS NULL OR due_date>=CURRENT_DATE))::int AS due,
      COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND outstanding_minor>0 AND due_date<CURRENT_DATE)::int AS overdue,
      COUNT(*) FILTER (WHERE status='paid')::int AS paid
    FROM customer_invoices WHERE tenant_id=$1
  `,[tenant.id])).rows[0];

  const filters=[
    ['all','All',null],
    ['draft','Draft',counts.drafts],
    ['due','Due',counts.due],
    ['overdue','Overdue',counts.overdue],
    ['paid','Paid',counts.paid]
  ].map(([key,label,count])=>`<a class="btn ${filter===key?'gold':'light'}" href="/invoices?filter=${key}${q?`&q=${encodeURIComponent(q)}`:''}">${label}${count!==null?` (${count})`:''}</a>`).join('');

  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Due date</th><th>Total</th><th>Outstanding</th><th>Status</th><th>Reminder</th><th></th></tr></thead><tbody>${rows.map(r=>{
    const canRemind=r.locked_at&&Number(r.outstanding_minor)>0&&r.email;
    const reminder=r.reminder_sent_at?`<span class="muted">Last sent ${fmtDate(r.reminder_sent_at)}${Number(r.reminder_count)>1?` · ${r.reminder_count} times`:''}</span>`:'';
    return `<tr>
      <td><strong>${esc(r.invoice_number||'Draft')}</strong><br><span class="muted">${fmtDate(r.issue_date||r.created_at)}</span></td>
      <td><strong>${esc(r.company_name||r.contact_name)}</strong><br><span class="muted">${esc(r.email||'')}</span></td>
      <td>${fmtDate(r.due_date)}</td>
      <td>${euro(r.total_minor)}</td>
      <td><strong>${euro(r.outstanding_minor)}</strong></td>
      <td>${statusPill(r.status)}</td>
      <td>${canRemind?`<form method="post" action="/invoices/${r.id}/remind" onsubmit="return confirm('Send a friendly payment reminder to ${esc(r.email)}?');"><button class="btn light" type="submit">Send reminder</button></form>${reminder}`:reminder||'—'}</td>
      <td><a class="btn light" href="/invoices/${r.id}">Open</a></td>
    </tr>`;
  }).join('')}</tbody></table></div>`:'<p class="sub">No invoices match this search/filter.</p>';

  const content=`<section class="card">
    <div class="actions" style="justify-content:space-between;margin-bottom:14px">
      <div><h2 style="margin:0">All invoices</h2><p class="sub" style="margin:4px 0 0">Search customers and keep on top of money due.</p></div>
      <a class="btn gold" href="/invoices/new">Create invoice</a>
    </div>
    <form method="get" action="/invoices" class="actions" style="margin-bottom:12px;align-items:end">
      <label style="min-width:300px;max-width:480px">Search by name, email or invoice number
        <input name="q" value="${esc(q)}" placeholder="e.g. Rachel, gmail.com or 0001575">
      </label>
      <input type="hidden" name="filter" value="${esc(filter)}">
      <button class="btn light">Search</button>
      ${q?'<a class="btn light" href="/invoices">Clear</a>':''}
    </form>
    <div class="actions" style="margin-bottom:16px">${filters}</div>
    ${table}
  </section>`;
  res.send(shell('Invoices','invoices',content,'Search, filter and chase outstanding Sotoboats invoices.'));
});

function lineRowsHtml(items=[]) {
  const rows=items.length?items:[{description_en:'',description_es:'',detail_en:'',detail_es:'',quantity:1,unit_price_minor:0,tax_rate:21}];
  const presetOptions='<option value="">Choose a description…</option>'+
    '<option value="tuition">Private sailing tuition</option>'+
    '<option value="sunseeker">Charter – Sunseeker</option>'+
    '<option value="catamaran">Charter – Catamaran</option>'+
    '<option value="jeanneau">Charter – Jeanneau sail boat</option>'+
    '<option value="morocco_tuition">Morocco sailing trip – Sailing tuition</option>'+
    '<option value="morocco_subsistence">Morocco sailing trip – Subsistence / cleaning / onboard facilities</option>'+
    '<option value="subsistence">Subsistence / cleaning / onboard facilities</option>'+
    '<option value="delivery">Boat delivery</option>'+
    '<option value="custom">Other / Custom description</option>';
  return rows.map((i)=>`<div class="line-grid line-row">
    <div class="preset-bar">
      <label>Description template<select class="description-preset">${presetOptions}</select></label>
      <label class="hours-wrap">Hours<input class="preset-hours" type="number" min="0.5" step="0.5" placeholder="4"></label>
      <label class="from-wrap">From<input class="preset-from" placeholder="Estepona"></label>
      <label class="to-wrap">To<input class="preset-to" placeholder="Ibiza"></label>
    </div>
    <div><label>English description<input class="desc-en" name="description_en" value="${esc(i.description_en||'')}" required></label><label style="margin-top:6px">English detail<input name="detail_en" value="${esc(i.detail_en||'')}"></label></div>
    <div><label>Spanish description<input class="desc-es" name="description_es" value="${esc(i.description_es||'')}"></label><label style="margin-top:6px">Spanish detail<input name="detail_es" value="${esc(i.detail_es||'')}"></label></div>
    <label>Qty<input type="number" min="0.001" step="0.001" name="quantity" value="${Number(i.quantity||1)}" required></label>
    <label>Net unit €<input type="number" min="0" step="0.01" name="unit_price" value="${major(i.unit_price_minor||0).toFixed(2)}" required></label>
    <label>VAT<select name="tax_rate"><option value="0" ${Number(i.tax_rate)===0?'selected':''}>0%</option><option value="10" ${Number(i.tax_rate)===10?'selected':''}>10%</option><option value="21" ${Number(i.tax_rate)===21?'selected':''}>21%</option></select></label>
    <button class="remove" type="button">×</button>
  </div>`).join('');
}

async function invoiceForm(res, invoice=null, items=[]) {
  const tenant=await getTenant();
  const customers=(await pool.query(`SELECT * FROM invoice_customers WHERE tenant_id=$1 AND is_active=true ORDER BY COALESCE(company_name,contact_name),contact_name`,[tenant.id])).rows;
  const edit=!!invoice;
  const today=new Date().toISOString().slice(0,10);
  const issueDate=iso(invoice?.issue_date)||today;
  const defaultDue=new Date(Date.now()+tenant.payment_terms_days*86400000).toISOString().slice(0,10);
  const dueDate=iso(invoice?.due_date)||defaultDue;
  const action=edit?`/invoices/${invoice.id}/edit`:'/invoices/new';
  const content=`<section class="form-card"><div class="actions" style="justify-content:space-between"><div><h2>${edit?'Edit draft':'New invoice'}</h2><p class="sub">Invoice numbers are allocated only when you issue the invoice.</p></div>${edit?`<a class="btn light" href="/invoices/${invoice.id}">Back to invoice</a>`:''}</div><form method="post" action="${action}" id="invoiceForm"><div class="form-grid three"><label>Customer<select name="customer_id" id="invoiceCustomer" required><option value="">Choose customer</option>${customers.map(c=>`<option value="${c.id}" ${invoice?.customer_id===c.id?'selected':''}>${esc(c.company_name||c.contact_name)}</option>`).join('')}</select><a id="editInvoiceCustomer" href="${invoice?.customer_id?`/customers/${invoice.customer_id}/edit`:''}" target="_blank" style="font-size:9px;margin-top:4px;${invoice?.customer_id?'':'display:none'}">Edit selected customer ↗</a></label><label>Invoice language<select name="invoice_language"><option value="bilingual" ${invoice?.invoice_language==='bilingual'||!invoice?'selected':''}>Bilingual</option><option value="en" ${invoice?.invoice_language==='en'?'selected':''}>English</option><option value="es" ${invoice?.invoice_language==='es'?'selected':''}>Spanish</option></select></label><label>Booking reference<input name="booking_reference" value="${esc(invoice?.booking_reference||'')}"></label><label>Service / course title<input name="service_title" value="${esc(invoice?.service_title||'')}" placeholder="e.g. Private Sailing Tuition" required></label><label>Start date<input id="serviceStart" type="date" name="service_start_date" value="${iso(invoice?.service_start_date)}"></label><label>End date<input type="date" name="service_end_date" value="${iso(invoice?.service_end_date)}"></label><label>Issue date<input type="date" name="issue_date" value="${issueDate}"></label><label>Due date<input type="date" name="due_date" value="${dueDate}"></label><label>Payment due now<select id="paymentMode" name="payment_mode"><option value="auto" ${invoice?.payment_mode==='auto'||!invoice?'selected':''}>Auto from booking date</option><option value="full" ${invoice?.payment_mode==='full'?'selected':''}>Full balance</option><option value="deposit" ${invoice?.payment_mode==='deposit'?'selected':''}>25% deposit</option><option value="custom" ${invoice?.payment_mode==='custom'?'selected':''}>Custom amount</option></select></label><label id="customDueWrap" class="${invoice?.payment_mode==='custom'?'':'hide'}">Custom amount due €<input id="customDue" type="number" step="0.01" min="0" name="custom_amount_due" value="${invoice?.payment_mode==='custom'&&invoice.amount_due_now_minor!=null?major(invoice.amount_due_now_minor).toFixed(2):''}"></label><label>Customer reference<input name="customer_reference" value="${esc(invoice?.customer_reference||'')}"></label><label>Bank transfer<select name="bank_transfer_enabled"><option value="1" ${invoice?.bank_transfer_enabled!==false?'selected':''}>Enabled</option><option value="0" ${invoice?.bank_transfer_enabled===false?'selected':''}>Disabled</option></select></label></div><div class="card" style="margin-top:16px;background:#fbfcfc"><h2>Invoice lines</h2><div id="lineRows">${lineRowsHtml(items)}</div><div class="actions" style="margin-top:10px"><button class="btn light" type="button" id="addLine">+ Add line</button></div><div class="totals"><div class="totals-row"><span>Net</span><strong id="calcNet">€0.00</strong></div><div class="totals-row"><span>VAT</span><strong id="calcVat">€0.00</strong></div><div class="totals-row total"><span>Total</span><strong id="calcTotal">€0.00</strong></div><div class="totals-row"><span>Due now</span><strong id="calcDue">€0.00</strong></div></div></div><div class="form-grid"><label class="full">Customer notes<textarea name="customer_notes">${esc(invoice?.customer_notes||'')}</textarea></label><label class="full">Internal notes<textarea name="internal_notes">${esc(invoice?.internal_notes||'')}</textarea></label></div><div class="notice" id="depositNotice" style="margin-top:12px">The automatic rule uses Sotoboats' current terms: 25% deposit when the start date is more than 30 days away; otherwise full payment is due.</div><div class="actions" style="margin-top:14px"><button class="btn gold">${edit?'Save draft changes':'Save draft'}</button></div></form></section><script>
  const depPct=${Number(tenant.deposit_percent)}; const threshold=${Number(tenant.deposit_threshold_days)};
  const descriptionPresets={
    tuition:{type:'hours',
      en:function(h){return 'Private sailing tuition (departing from Estepona, life jackets provided. Up to '+(h||'X')+' hour'+(Number(h)===1?'':'s')+' of sailing)';},
      es:function(h){return 'Clases particulares de vela (salida desde Estepona, chalecos salvavidas incluidos. Hasta '+(h||'X')+' hora'+(Number(h)===1?'':'s')+' de navegación)';}},
    sunseeker:{type:'hours',
      en:function(h){return (h||'X')+' hour'+(Number(h)===1?'':'s')+' charter – Sunseeker (including Captain, host, snacks, cava, white wine, beer and soft drinks)';},
      es:function(h){return 'Chárter de '+(h||'X')+' hora'+(Number(h)===1?'':'s')+' – Sunseeker (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)';}},
    catamaran:{type:'hours',
      en:function(h){return (h||'X')+' hour'+(Number(h)===1?'':'s')+' charter – Catamaran (including Captain, host, snacks, cava, white wine, beer and soft drinks)';},
      es:function(h){return 'Chárter de '+(h||'X')+' hora'+(Number(h)===1?'':'s')+' – Catamarán (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)';}},
    jeanneau:{type:'hours',
      en:function(h){return (h||'X')+' hour'+(Number(h)===1?'':'s')+' charter – Jeanneau sail boat (including Captain, host, snacks, cava, white wine, beer and soft drinks)';},
      es:function(h){return 'Chárter de '+(h||'X')+' hora'+(Number(h)===1?'':'s')+' – Velero Jeanneau (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)';}},
    morocco_tuition:{type:'fixed',
      en:function(){return 'Morocco sailing trip – Sailing tuition';},
      es:function(){return 'Viaje a vela a Marruecos – Clases de vela';}},
    morocco_subsistence:{type:'fixed',
      en:function(){return 'Morocco sailing trip – Subsistence, cleaning, use of onboard facilities';},
      es:function(){return 'Viaje a vela a Marruecos – Manutención, limpieza y uso de las instalaciones a bordo';}},
    subsistence:{type:'fixed',
      en:function(){return 'Subsistence, cleaning, use of onboard facilities';},
      es:function(){return 'Manutención, limpieza y uso de las instalaciones a bordo';}},
    delivery:{type:'route',
      en:function(a,b){return 'Boat delivery from '+(a||'X')+' to '+(b||'X')+' (excluding fuel, insurance)';},
      es:function(a,b){return 'Traslado de embarcación de '+(a||'X')+' a '+(b||'X')+' (combustible y seguro no incluidos)';}}
  };

  function updatePreset(row){
    const key=row.querySelector('.description-preset').value||'';
    const bar=row.querySelector('.preset-bar');
    bar.classList.remove('show-hours','show-route');
    if(!key || key==='custom') return;
    const p=descriptionPresets[key];
    if(!p) return;
    if(p.type==='hours') bar.classList.add('show-hours');
    if(p.type==='route') bar.classList.add('show-route');
    const h=row.querySelector('.preset-hours').value||'';
    const a=row.querySelector('.preset-from').value||'';
    const b=row.querySelector('.preset-to').value||'';
    row.querySelector('.desc-en').value=p.type==='route'?p.en(a,b):p.en(h);
    row.querySelector('.desc-es').value=p.type==='route'?p.es(a,b):p.es(h);
  }

  function wireLineRow(row){
    const remove=row.querySelector('.remove');
    if(remove) remove.addEventListener('click',function(){
      if(document.querySelectorAll('.line-row').length>1){row.remove();}
      else{
        row.querySelector('.desc-en').value='';
        row.querySelector('.desc-es').value='';
        row.querySelectorAll('input[name=detail_en],input[name=detail_es]').forEach(function(x){x.value='';});
        row.querySelector('[name=unit_price]').value='0.00';
      }
      calcInvoice();
    });
    row.querySelector('.description-preset').addEventListener('change',function(){updatePreset(row);});
    row.querySelector('.preset-hours').addEventListener('input',function(){updatePreset(row);});
    row.querySelector('.preset-from').addEventListener('input',function(){updatePreset(row);});
    row.querySelector('.preset-to').addEventListener('input',function(){updatePreset(row);});
    row.querySelectorAll('input,select').forEach(function(x){x.addEventListener('input',calcInvoice);});
  }

  function addLine(){
    const wrap=document.getElementById('lineRows');
    const d=document.createElement('div');
    d.className='line-grid line-row';
    d.innerHTML=
      '<div class="preset-bar">'+
        '<label>Description template<select class="description-preset">'+
          '<option value="">Choose a description…</option>'+
          '<option value="tuition">Private sailing tuition</option>'+
          '<option value="sunseeker">Charter – Sunseeker</option>'+
          '<option value="catamaran">Charter – Catamaran</option>'+
          '<option value="jeanneau">Charter – Jeanneau sail boat</option>'+
          '<option value="morocco_tuition">Morocco sailing trip – Sailing tuition</option>'+
          '<option value="morocco_subsistence">Morocco sailing trip – Subsistence / cleaning / onboard facilities</option>'+
          '<option value="subsistence">Subsistence / cleaning / onboard facilities</option>'+
          '<option value="delivery">Boat delivery</option>'+
          '<option value="custom">Other / Custom description</option>'+
        '</select></label>'+
        '<label class="hours-wrap">Hours<input class="preset-hours" type="number" min="0.5" step="0.5" placeholder="4"></label>'+
        '<label class="from-wrap">From<input class="preset-from" placeholder="Estepona"></label>'+
        '<label class="to-wrap">To<input class="preset-to" placeholder="Ibiza"></label>'+
      '</div>'+
      '<div><label>English description<input class="desc-en" name="description_en" required></label><label style="margin-top:6px">English detail<input name="detail_en"></label></div>'+
      '<div><label>Spanish description<input class="desc-es" name="description_es"></label><label style="margin-top:6px">Spanish detail<input name="detail_es"></label></div>'+
      '<label>Qty<input type="number" min="0.001" step="0.001" name="quantity" value="1" required></label>'+
      '<label>Net unit €<input type="number" min="0" step="0.01" name="unit_price" value="0.00" required></label>'+
      '<label>VAT<select name="tax_rate"><option value="0">0%</option><option value="10">10%</option><option value="21" selected>21%</option></select></label>'+
      '<button class="remove" type="button">×</button>';
    wrap.appendChild(d);
    wireLineRow(d);
    calcInvoice();
  }

  function calcInvoice(){
    let net=0,vat=0;
    document.querySelectorAll('.line-row').forEach(function(r){
      const q=parseFloat(r.querySelector('[name=quantity]').value)||0;
      const p=parseFloat(r.querySelector('[name=unit_price]').value)||0;
      const t=parseFloat(r.querySelector('[name=tax_rate]').value)||0;
      const n=q*p;net+=n;vat+=n*t/100;
    });
    const total=net+vat;
    let due=total;
    const mode=document.getElementById('paymentMode').value;
    document.getElementById('customDueWrap').classList.toggle('hide',mode!=='custom');
    if(mode==='deposit')due=total*depPct/100;
    if(mode==='custom')due=parseFloat(document.getElementById('customDue').value)||0;
    if(mode==='auto'){
      const s=document.getElementById('serviceStart').value;
      if(s){
        const days=(new Date(s+'T12:00:00')-new Date())/86400000;
        due=days>threshold?total*depPct/100:total;
      }
    }
    document.getElementById('calcNet').textContent='€'+net.toFixed(2);
    document.getElementById('calcVat').textContent='€'+vat.toFixed(2);
    document.getElementById('calcTotal').textContent='€'+total.toFixed(2);
    document.getElementById('calcDue').textContent='€'+Math.max(0,due).toFixed(2);
  }

  const customerSelect=document.getElementById('invoiceCustomer');
  const editCustomerLink=document.getElementById('editInvoiceCustomer');
  if(customerSelect&&editCustomerLink){
    customerSelect.addEventListener('change',function(){
      if(this.value){
        editCustomerLink.href='/customers/'+this.value+'/edit';
        editCustomerLink.style.display='inline-block';
      }else{
        editCustomerLink.style.display='none';
      }
    });
  }

  document.querySelectorAll('.line-row').forEach(wireLineRow);
  document.getElementById('addLine').addEventListener('click',addLine);
  document.getElementById('invoiceForm').addEventListener('input',calcInvoice);
  calcInvoice();
  </script>`;
  res.send(shell(edit?'Edit Invoice':'Create Invoice','invoices',content,'Spanish VAT by line, bilingual wording and Sotoboats deposit logic.'));
}

app.get('/invoices/new',async(req,res)=>invoiceForm(res));

async function saveInvoice(req,res,existingId=null){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const tenant=await getTenant(client); const b=req.body;
    if(!b.customer_id) throw new Error('Please select a customer.');
    const descEn=Array.isArray(b.description_en)?b.description_en:[b.description_en];
    const descEs=Array.isArray(b.description_es)?b.description_es:[b.description_es];
    const detEn=Array.isArray(b.detail_en)?b.detail_en:[b.detail_en];
    const detEs=Array.isArray(b.detail_es)?b.detail_es:[b.detail_es];
    const qty=Array.isArray(b.quantity)?b.quantity:[b.quantity];
    const price=Array.isArray(b.unit_price)?b.unit_price:[b.unit_price];
    const tax=Array.isArray(b.tax_rate)?b.tax_rate:[b.tax_rate];
    const lines=[];
    for(let i=0;i<descEn.length;i++){
      if(!String(descEn[i]||'').trim()) continue;
      const c=calculateLine(qty[i],price[i],tax[i]);
      if(c.qty<=0) continue;
      lines.push({description_en:String(descEn[i]).trim(),description_es:String(descEs[i]||'').trim()||null,detail_en:String(detEn[i]||'').trim()||null,detail_es:String(detEs[i]||'').trim()||null,tax_rate:Number(tax[i]||0),...c});
    }
    if(!lines.length) throw new Error('Add at least one valid invoice line.');
    const subtotal=lines.reduce((s,l)=>s+l.net,0); const vat=lines.reduce((s,l)=>s+l.tax,0); const total=subtotal+vat;
    let dueNow=total; const mode=b.payment_mode||'auto';
    if(mode==='deposit') dueNow=Math.round(total*Number(tenant.deposit_percent)/100);
    if(mode==='custom') dueNow=Math.min(total,Math.max(0,minor(b.custom_amount_due)));
    if(mode==='auto' && b.service_start_date){const now=new Date();const start=new Date(`${b.service_start_date}T12:00:00`);const days=(start-now)/86400000;dueNow=days>Number(tenant.deposit_threshold_days)?Math.round(total*Number(tenant.deposit_percent)/100):total;}
    let invoiceId=existingId;
    if(existingId){
      const current=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[existingId,tenant.id])).rows[0];
      if(!current) throw new Error('Invoice not found.');
      if(current.locked_at) throw new Error('Issued invoices are locked. Create a correction instead of editing this invoice.');
      await client.query(`UPDATE customer_invoices SET customer_id=$1,invoice_language=$2,issue_date=$3,due_date=$4,service_title=$5,service_start_date=$6,service_end_date=$7,booking_reference=$8,customer_reference=$9,customer_notes=$10,internal_notes=$11,subtotal_minor=$12,tax_minor=$13,total_minor=$14,outstanding_minor=$14,amount_due_now_minor=$15,payment_mode=$16,bank_transfer_enabled=$17,updated_at=now() WHERE id=$18`,[b.customer_id,b.invoice_language||tenant.default_language,b.issue_date||null,b.due_date||null,b.service_title,b.service_start_date||null,b.service_end_date||null,b.booking_reference||null,b.customer_reference||null,b.customer_notes||null,b.internal_notes||null,subtotal,vat,total,dueNow,mode,b.bank_transfer_enabled==='1',existingId]);
      await client.query(`DELETE FROM customer_invoice_items WHERE invoice_id=$1`,[existingId]);
    }else{
      invoiceId=(await client.query(`INSERT INTO customer_invoices(tenant_id,customer_id,invoice_language,issue_date,due_date,service_title,service_start_date,service_end_date,booking_reference,customer_reference,customer_notes,internal_notes,subtotal_minor,tax_minor,total_minor,outstanding_minor,amount_due_now_minor,payment_mode,bank_transfer_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18) RETURNING id`,[tenant.id,b.customer_id,b.invoice_language||tenant.default_language,b.issue_date||null,b.due_date||null,b.service_title,b.service_start_date||null,b.service_end_date||null,b.booking_reference||null,b.customer_reference||null,b.customer_notes||null,b.internal_notes||null,subtotal,vat,total,dueNow,mode,b.bank_transfer_enabled==='1'])).rows[0].id;
    }
    for(let i=0;i<lines.length;i++){const l=lines[i];await client.query(`INSERT INTO customer_invoice_items(invoice_id,sort_order,description_en,description_es,detail_en,detail_es,quantity,unit_price_minor,tax_rate,line_net_minor,line_tax_minor,line_total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[invoiceId,i,l.description_en,l.description_es,l.detail_en,l.detail_es,l.qty,l.unit,l.tax_rate,l.net,l.tax,l.total]);}
    await client.query(`INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details) VALUES($1,$2,$3,'Sotoboats Admin',jsonb_build_object('total_minor',to_jsonb($4::bigint)))`,[tenant.id,invoiceId,existingId?'draft_updated':'draft_created',total]);
    await client.query('COMMIT'); res.redirect(`/invoices/${invoiceId}`);
  }catch(err){await client.query('ROLLBACK');res.status(400).send(shell('Invoice error','invoices',`<section class="card"><h2>Could not save invoice</h2><p class="sub">${esc(err.message)}</p><div class="actions"><a class="btn" href="javascript:history.back()">Go back</a></div></section>`));}finally{client.release();}
}
app.post('/invoices/new',(req,res)=>saveInvoice(req,res));
app.get('/invoices/:id/edit',async(req,res)=>{const data=await loadInvoice(req.params.id);if(!data)return res.status(404).send('Invoice not found');if(data.invoice.locked_at)return res.redirect(`/invoices/${req.params.id}`);invoiceForm(res,data.invoice,data.items);});
app.post('/invoices/:id/edit',(req,res)=>saveInvoice(req,res,req.params.id));

function invoicePreview(data){
  const {tenant,invoice:i,items}=data;
  const showEn=i.invoice_language!=='es', showEs=i.invoice_language!=='en';
  const vatGroups={}; items.forEach(x=>{const k=Number(x.tax_rate).toFixed(0);vatGroups[k]=(vatGroups[k]||0)+Number(x.line_tax_minor)});
  const identity=i.identity_number?`<p>${esc(i.identity_type||'ID')}: ${esc(i.identity_number)}</p>`:'';
  const rows=items.map(x=>`<tr><td><strong>${showEn?esc(x.description_en):esc(x.description_es||x.description_en)}</strong>${showEn&&x.detail_en?`<br><span class="muted">${esc(x.detail_en)}</span>`:''}${showEs&&x.description_es?`<br><span class="muted">${esc(x.description_es)}</span>`:''}${showEs&&x.detail_es?`<br><span class="muted">${esc(x.detail_es)}</span>`:''}</td><td>${Number(x.quantity)}</td><td>${euro(x.unit_price_minor)}</td><td>${Number(x.tax_rate).toFixed(0)}%</td><td>${euro(x.line_total_minor)}</td></tr>`).join('');
  return `<div class="invoice-sheet" id="invoiceSheet"><div class="invoice-head"><div class="invoice-brand"><img src="/sotoboats-logo.png" alt="Sotoboats" style="display:block;width:215px;max-width:100%;height:auto;margin:0 0 10px"><p><strong>${esc(tenant.legal_name)}</strong></p><p>${esc(tenant.address_1||'')} · ${esc(tenant.postcode||'')} ${esc(tenant.city||'')}</p><p>${esc(tenant.region||'')} · ${esc(tenant.country_name||'')}</p><p>${esc(tenant.email||'')} · ${esc(tenant.phone||'')}</p><p>Company ID: ${esc(tenant.tax_id||'')}</p></div><div class="invoice-meta"><strong>Invoice / Factura ${esc(i.invoice_number||'DRAFT')}</strong><p>Issue date / Fecha: ${fmtDate(i.issue_date)}</p><p>Due date / Vencimiento: ${fmtDate(i.due_date)}</p>${i.booking_reference?`<p>Booking ref: ${esc(i.booking_reference)}</p>`:''}</div></div><div class="billto"><div><div class="eyebrow">Bill to / Facturar a</div><p><strong>${esc(i.company_name||i.contact_name)}</strong></p>${i.company_name?`<p>${esc(i.contact_name)}</p>`:''}<p>${esc([i.billing_address_1,i.billing_address_2,i.billing_city,i.billing_region,i.billing_postcode].filter(Boolean).join(', '))}</p>${identity}</div><div><div class="eyebrow">Customer / Cliente</div><p>${esc(i.email||'')}</p><p>${esc(i.phone||'')}</p>${i.tax_number?`<p>Tax ID: ${esc(i.tax_number)}</p>`:''}</div></div><h3 class="invoice-title">${esc(i.service_title||'Invoice')}${i.service_start_date?` | ${fmtDate(i.service_start_date)}${i.service_end_date?` to ${fmtDate(i.service_end_date)}`:''}`:''}</h3><table class="invoice-table"><thead><tr><th>Product or Service</th><th>Qty</th><th>Net</th><th>VAT</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><div class="invoice-summary"><div class="summary-row"><span>Subtotal</span><strong>${euro(i.subtotal_minor)}</strong></div>${Object.entries(vatGroups).sort((a,b)=>Number(a[0])-Number(b[0])).map(([rate,amt])=>`<div class="summary-row"><span>IVA / VAT ${rate}%</span><strong>${euro(amt)}</strong></div>`).join('')}<div class="summary-row"><span>Tax total</span><strong>${euro(i.tax_minor)}</strong></div><div class="summary-row"><span>Invoice total</span><strong>${euro(i.total_minor)}</strong></div><div class="summary-row"><span>Amount paid</span><strong>${euro(i.paid_minor)}</strong></div>${Number(i.credited_minor||0)>0?`<div class="summary-row"><span>Credit notes</span><strong>-${euro(i.credited_minor)}</strong></div>`:''}<div class="summary-row final"><span>Balance due</span><strong>${euro(i.outstanding_minor)}</strong></div>${Number(i.paid_minor||0)+Number(i.credited_minor||0)>Number(i.total_minor||0)?`<div class="summary-row" style="margin-top:7px;background:#f6efe3;border-radius:8px"><span>Customer credit / refund due</span><strong>${euro(Number(i.paid_minor)+Number(i.credited_minor)-Number(i.total_minor))}</strong></div>`:''}${i.amount_due_now_minor!=null&&Number(i.amount_due_now_minor)<Number(i.outstanding_minor)?`<div class="summary-row" style="margin-top:7px;background:#f6efe3;border-radius:8px"><span>Amount due now</span><strong>${euro(i.amount_due_now_minor)}</strong></div>`:''}</div>${i.customer_notes?`<div class="lang-block"><strong>Notes</strong><br>${esc(i.customer_notes)}</div>`:''}${showEn?`<div class="lang-block"><strong>English</strong><p>${esc(tenant.english_footer||'')}</p>${i.bank_transfer_enabled?`<p><strong>Bank transfer:</strong> ${esc(tenant.bank_account_name||'')} · IBAN ${esc(tenant.bank_iban||'')} · BIC ${esc(tenant.bank_bic||'')}</p>`:''}</div>`:''}${showEs?`<div class="lang-block"><strong>Español</strong><p>${esc(tenant.spanish_footer||'')}</p>${i.bank_transfer_enabled?`<p><strong>Transferencia bancaria:</strong> ${esc(tenant.bank_account_name||'')} · IBAN ${esc(tenant.bank_iban||'')} · BIC ${esc(tenant.bank_bic||'')}</p>`:''}</div>`:''}</div>`;
}


function getMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Email is not configured yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in Render Environment.');
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: {
      servername: host
    }
  });
}

function invoiceEmailHtml(data) {
  const { tenant, invoice:i } = data;
  const balance = euro(i.outstanding_minor);
  const due = fmtDate(i.due_date);
  const name = esc(i.contact_name || i.company_name || 'Customer');
  const invoiceNo = esc(i.invoice_number || '');
  return `<!doctype html>
  <html><body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#183247">
    <div style="max-width:650px;margin:0 auto;padding:28px 16px">
      <div style="background:#0b1d2f;padding:24px;border-radius:14px 14px 0 0">
        <div style="color:#caa86d;font-size:12px;letter-spacing:.16em;font-weight:700">SOTOBOATS</div>
        <div style="color:#fff;font-size:24px;font-weight:700;margin-top:5px">Invoice ${invoiceNo}</div>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #e1e7ea;border-top:0;border-radius:0 0 14px 14px">
        <p style="margin-top:0">Hello ${name},</p>
        <p>Please find attached your invoice from <strong>Sotoboats / ${esc(tenant.legal_name)}</strong>.</p>
        <div style="background:#f5f8fa;border-radius:10px;padding:18px;margin:20px 0">
          <div style="font-size:12px;color:#72838d">Balance due</div>
          <div style="font-size:28px;font-weight:700;color:#0b1d2f;margin-top:3px">${balance}</div>
          <div style="font-size:12px;color:#72838d;margin-top:5px">Due ${due}</div>
        </div>
        <p>Payment details are included on the attached invoice.</p>
        <p style="margin-bottom:0">Thank you,<br><strong>Sotoboats</strong></p>
      </div>
      <div style="text-align:center;color:#8998a0;font-size:11px;padding:16px">
        ${esc(tenant.legal_name)} · ${esc(tenant.email || '')}
      </div>
    </div>
  </body></html>`;
}


function paymentReminderHtml(data) {
  const {tenant,invoice:i}=data;
  const overdue=i.due_date && dateYmd(i.due_date) < new Date().toISOString().slice(0,10);
  const name=esc(i.contact_name||i.company_name||'Customer');
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#183247">
  <div style="max-width:650px;margin:0 auto;padding:28px 16px">
    <div style="background:#0b1d2f;padding:22px;border-radius:14px 14px 0 0">
      <div style="color:#caa86d;font-size:12px;letter-spacing:.16em;font-weight:700">SOTOBOATS</div>
      <div style="color:#fff;font-size:22px;font-weight:700;margin-top:5px">A quick payment reminder</div>
    </div>
    <div style="background:#fff;padding:28px;border:1px solid #e1e7ea;border-top:0;border-radius:0 0 14px 14px">
      <p style="margin-top:0">Hello ${name},</p>
      <p>Just a friendly reminder that there is still a balance outstanding on Sotoboats invoice <strong>${esc(i.invoice_number||'')}</strong>.</p>
      <div style="background:#f5f8fa;border-radius:10px;padding:18px;margin:20px 0">
        <div style="font-size:12px;color:#72838d">Balance outstanding</div>
        <div style="font-size:28px;font-weight:700;color:#0b1d2f;margin-top:3px">${euro(i.outstanding_minor)}</div>
        <div style="font-size:12px;color:#72838d;margin-top:5px">${overdue?'Was due':'Due'} ${fmtDate(i.due_date)}</div>
      </div>
      <p>If payment has already been made, please disregard this message. Otherwise, the payment details are included on the attached invoice.</p>
      <p style="margin-bottom:0">Many thanks,<br><strong>Sotoboats</strong></p>
    </div>
    <div style="text-align:center;color:#8998a0;font-size:11px;padding:16px">${esc(tenant.legal_name)} · ${esc(tenant.email||'')}</div>
  </div></body></html>`;
}

function buildInvoicePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    try {
      const {tenant,invoice:i,items}=data;
      const chunks=[];
      const doc=new PDFDocument({size:'A4',margin:45});
      doc.on('data',c=>chunks.push(c));
      doc.on('end',()=>resolve(Buffer.concat(chunks)));
      doc.on('error',reject);

      const navy='#0b1d2f', gold='#caa86d', muted='#667783';
      const logoPath=path.join(__dirname,'public','sotoboats-logo.png');
      if(fs.existsSync(logoPath)){
        doc.image(logoPath,45,42,{width:215});
      }else{
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(25).text('SOTOBOATS',45,45);
      }
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        `${tenant.legal_name}\n${tenant.address_1 || ''}\n${tenant.postcode || ''} ${tenant.city || ''}, ${tenant.region || ''}\n${tenant.country_name || ''}\n${tenant.email || ''} · ${tenant.phone || ''}\nCompany ID: ${tenant.tax_id || ''}`,
        45,90,{width:250}
      );
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(15).text(`Invoice / Factura ${i.invoice_number}`,330,48,{width:220,align:'right'});
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        `Issue date: ${fmtDate(i.issue_date)}\nDue date: ${fmtDate(i.due_date)}${i.booking_reference?`\nBooking ref: ${i.booking_reference}`:''}`,
        330,72,{width:220,align:'right'}
      );

      doc.moveTo(45,150).lineTo(550,150).strokeColor('#dce3e6').stroke();
      doc.fillColor(gold).font('Helvetica-Bold').fontSize(8).text('BILL TO / FACTURAR A',45,166);
      doc.fillColor(navy).fontSize(10).text(i.company_name||i.contact_name,45,180);
      const billToLines = [
        i.company_name ? i.contact_name : null,
        [i.billing_address_1,i.billing_address_2,i.billing_city,i.billing_region,i.billing_postcode].filter(Boolean).join(', '),
        i.identity_number ? `${i.identity_type||'ID'}: ${i.identity_number}` : null,
        i.email || null,
        i.phone || null
      ].filter(Boolean).join('\n');
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        billToLines,
        45,195,{width:250}
      );

      let y=250;
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(15).text(
        `${i.service_title||'Invoice'}${i.service_start_date?` | ${fmtDate(i.service_start_date)}${i.service_end_date?` to ${fmtDate(i.service_end_date)}`:''}`:''}`,
        45,y,{width:505}
      );
      y+=30;
      doc.rect(45,y,505,24).fill('#e7eef5');
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('Product or Service',53,y+8);
      doc.text('Qty',335,y+8); doc.text('Net',380,y+8); doc.text('VAT',435,y+8); doc.text('Total',485,y+8);
      y+=30;

      const showEs=i.invoice_language!=='en';
      for(const item of items){
        const label=[item.description_en,showEs&&item.description_es?item.description_es:null].filter(Boolean).join(' / ');
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text(label,53,y,{width:265});
        doc.fillColor(muted).font('Helvetica').fontSize(7).text([item.detail_en,showEs?item.detail_es:null].filter(Boolean).join(' / '),53,y+12,{width:265});
        doc.fillColor(navy).fontSize(8).text(String(Number(item.quantity)),337,y);
        doc.text(euro(item.unit_price_minor),376,y);
        doc.text(`${Number(item.tax_rate).toFixed(0)}%`,438,y);
        doc.text(euro(item.line_total_minor),482,y);
        y+=42;
        if(y>650){doc.addPage();y=55;}
      }

      y+=8;
      doc.moveTo(330,y).lineTo(550,y).strokeColor('#dce3e6').stroke();
      y+=10;
      const vatGroups={};
      items.forEach(x=>{const k=Number(x.tax_rate).toFixed(0);vatGroups[k]=(vatGroups[k]||0)+Number(x.line_tax_minor)});
      const summary=[
        ['Subtotal',i.subtotal_minor],
        ...Object.entries(vatGroups).map(([r,a])=>[`IVA / VAT ${r}%`,a]),
        ['Tax total',i.tax_minor],
        ['Invoice total',i.total_minor],
        ['Amount paid',i.paid_minor],
        ...(Number(i.credited_minor||0)>0?[['Credit notes',-Number(i.credited_minor)]]:[]),
        ['Balance due',i.outstanding_minor],
        ...((Number(i.paid_minor||0)+Number(i.credited_minor||0)>Number(i.total_minor||0))?[['Customer credit / refund due',Number(i.paid_minor)+Number(i.credited_minor)-Number(i.total_minor)]]:[])
      ];
      for(const [label,amt] of summary){
        const final=label==='Balance due';
        if(final) doc.rect(325,y-4,225,24).fill('#eef4f7');
        doc.fillColor(navy).font(final?'Helvetica-Bold':'Helvetica').fontSize(final?11:8).text(label,335,y);
        const displayAmt=Number(amt)<0?'-'+euro(Math.abs(Number(amt))):euro(amt);
        doc.text(displayAmt,465,y,{width:75,align:'right'});
        y+=final?30:20;
      }

      if(i.amount_due_now_minor!=null&&Number(i.amount_due_now_minor)<Number(i.outstanding_minor)){
        doc.fillColor(gold).font('Helvetica-Bold').fontSize(9).text(`Amount due now: ${euro(i.amount_due_now_minor)}`,335,y);
        y+=24;
      }

      if(y>675){doc.addPage();y=55;}
      doc.moveTo(45,y).lineTo(550,y).strokeColor('#dce3e6').stroke(); y+=15;
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('English',45,y); y+=12;
      doc.fillColor(muted).font('Helvetica').fontSize(7).text(tenant.english_footer||'',45,y,{width:505}); y+=55;
      if(i.bank_transfer_enabled){
        doc.fillColor(navy).font('Helvetica-Bold').text(
          `Bank transfer: ${tenant.bank_account_name||''} · IBAN ${tenant.bank_iban||''} · BIC ${tenant.bank_bic||''}`,
          45,y,{width:505}
        );
        y+=25;
      }
      if(i.invoice_language!=='en'){
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('Español',45,y); y+=12;
        doc.fillColor(muted).font('Helvetica').fontSize(7).text(tenant.spanish_footer||'',45,y,{width:505});
      }
      doc.end();
    } catch(err) {
      reject(err);
    }
  });
}

app.get('/invoices/:id',async(req,res)=>{
  const data=await loadInvoice(req.params.id);
  if(!data)return res.status(404).send('Invoice not found.');
  const i=data.invoice;

  const creditNotes=(await pool.query(`
    SELECT * FROM customer_credit_notes
    WHERE original_invoice_id=$1 AND tenant_id=$2
    ORDER BY created_at DESC
  `,[i.id,data.tenant.id])).rows;
  const issuedCredits=creditNotes.filter(c=>c.status==='issued').reduce((s,c)=>s+Number(c.total_minor||0),0);
  const remainingCredit=Math.max(0,Number(i.total_minor||0)-issuedCredits);

  const emailBtn=i.locked_at&&i.email?`<form method="post" action="/invoices/${i.id}/email" onsubmit="return confirm('${i.emailed_at?'Resend':'Send'} invoice ${esc(i.invoice_number||'')} to ${esc(i.email)}?');"><button class="btn gold">${i.emailed_at?'Resend invoice':'Send invoice'}</button></form>`:'';
  const reminderBtn=i.locked_at&&i.email&&Number(i.outstanding_minor)>0?`<form method="post" action="/invoices/${i.id}/remind" onsubmit="return confirm('Send a friendly payment reminder to ${esc(i.email)}?');"><button class="btn light">Send reminder</button></form>`:'';
  const creditBtn=i.locked_at&&remainingCredit>0?`<a class="btn light" href="/invoices/${i.id}/credit-note">Create credit note</a>`:'';

  const controls=`<div class="actions no-print" style="margin-bottom:15px">${!i.locked_at?`<a class="btn light" href="/invoices/${i.id}/edit">Edit draft</a><form method="post" action="/invoices/${i.id}/issue" onsubmit="return confirm('Issue this invoice? Once issued, its financial content will be locked.');"><button class="btn gold">Issue invoice</button></form>`:`<a class="btn light" target="_blank" href="/invoices/${i.id}/pdf">Download PDF</a><button class="btn light" onclick="window.print()">Print</button>${emailBtn}${reminderBtn}${creditBtn}`}${i.emailed_at?`<span class="pill green">Emailed ${fmtDate(i.emailed_at)} to ${esc(i.emailed_to||i.email||'')}</span>`:''}<a class="btn light" href="/invoices">Back to invoices</a></div>`;

  const payment=i.locked_at&&Number(i.outstanding_minor)>0?`<section class="card no-print"><h2>Record payment</h2><form method="post" action="/invoices/${i.id}/payments"><div class="form-grid three"><label>Amount €<input type="number" step="0.01" min="0.01" max="${major(i.outstanding_minor).toFixed(2)}" name="amount" value="${major(i.amount_due_now_minor??i.outstanding_minor).toFixed(2)}" required></label><label>Method<select name="method"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card_external">Card - external</option><option value="other">Other</option></select></label><label>Reference<input name="reference"></label></div><div class="actions" style="margin-top:12px"><button class="btn gold">Record payment</button></div></form></section>`:'';

  const credits=creditNotes.length?`<section class="card no-print"><h2>Credit notes</h2><div class="table-wrap"><table><thead><tr><th>Credit note</th><th>Date</th><th>Reason</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${creditNotes.map(c=>`<tr><td><strong>${esc(c.credit_note_number||'Draft')}</strong></td><td>${fmtDate(c.issue_date||c.created_at)}</td><td>${esc(c.reason||'')}</td><td>${euro(c.total_minor)}</td><td>${creditStatusPill(c.status)}</td><td><a class="btn light" href="/credit-notes/${c.id}">Open</a></td></tr>`).join('')}</tbody></table></div></section>`:'';

  const audit=data.events.length?`<section class="card no-print"><h2>Audit trail</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Actor</th></tr></thead><tbody>${data.events.map(e=>`<tr><td>${fmtDate(e.created_at)}</td><td>${esc(e.event_type.replaceAll('_',' '))}</td><td>${esc(e.actor_name||'System')}</td></tr>`).join('')}</tbody></table></div></section>`:'';

  res.send(shell(i.invoice_number||'Draft Invoice','invoices',`${controls}${invoicePreview(data)}${payment}${credits}${audit}`,i.locked_at?'Issued invoices are locked. Payments and credit notes can still be recorded.':'This is a draft and can still be edited.'));
});

app.post('/invoices/:id/issue',async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const tenant=await getTenant(client);
    const i=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[req.params.id,tenant.id])).rows[0];
    if(!i) throw new Error('Invoice not found.');
    if(i.locked_at) throw new Error('Invoice has already been issued.');

    const customer=(await client.query(`SELECT * FROM invoice_customers WHERE id=$1 AND tenant_id=$2`,[i.customer_id,tenant.id])).rows[0];
    if(!customer) throw new Error('Customer record not found.');

    const t=(await client.query(`SELECT * FROM invoice_tenants WHERE id=$1 FOR UPDATE`,[tenant.id])).rows[0];
    const number=`${t.invoice_prefix||''}${String(t.next_invoice_number).padStart(Number(t.invoice_padding||7),'0')}`;
    const issue=i.issue_date||new Date().toISOString().slice(0,10);
    let due=i.due_date;
    if(!due){
      const d=new Date(`${issue}T12:00:00`);
      d.setDate(d.getDate()+Number(t.payment_terms_days||5));
      due=d.toISOString().slice(0,10);
    }

    await client.query(`
      UPDATE customer_invoices SET
        invoice_number=$1,issue_date=$2,due_date=$3,status='sent',issued_at=now(),locked_at=now(),updated_at=now(),
        snapshot_contact_name=$4,snapshot_company_name=$5,snapshot_email=$6,snapshot_phone=$7,
        snapshot_billing_address_1=$8,snapshot_billing_address_2=$9,snapshot_billing_city=$10,
        snapshot_billing_region=$11,snapshot_billing_postcode=$12,snapshot_billing_country_code=$13,
        snapshot_tax_number=$14,snapshot_identity_type=$15,snapshot_identity_number=$16
      WHERE id=$17
    `,[
      number,issue,due,
      customer.contact_name||null,customer.company_name||null,customer.email||null,customer.phone||null,
      customer.billing_address_1||null,customer.billing_address_2||null,customer.billing_city||null,
      customer.billing_region||null,customer.billing_postcode||null,customer.billing_country_code||null,
      customer.tax_number||null,customer.identity_type||null,customer.identity_number||null,
      i.id
    ]);

    await client.query(`UPDATE invoice_tenants SET next_invoice_number=next_invoice_number+1,updated_at=now() WHERE id=$1`,[tenant.id]);
    await client.query(
      `INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details)
       VALUES($1,$2,'invoice_issued','Sotoboats Admin',jsonb_build_object('invoice_number',to_jsonb($3::text)))`,
      [tenant.id,i.id,number]
    );
    await client.query('COMMIT');
    res.redirect(`/invoices/${i.id}`);
  }catch(err){
    await client.query('ROLLBACK');
    res.status(400).send(esc(err.message));
  }finally{
    client.release();
  }
});

app.post('/invoices/:id/payments',async(req,res)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const tenant=await getTenant(client);const i=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[req.params.id,tenant.id])).rows[0];if(!i)throw new Error('Invoice not found.');const amount=minor(req.body.amount);if(amount<=0||amount>Number(i.outstanding_minor))throw new Error('Invalid payment amount.');await client.query(`INSERT INTO customer_invoice_payments(tenant_id,invoice_id,amount_minor,currency_code,method,reference,paid_at) VALUES($1,$2,$3,'EUR',$4,$5,now())`,[tenant.id,i.id,amount,req.body.method||'bank_transfer',req.body.reference||null]);const paid=Number(i.paid_minor)+amount;const outstanding=Math.max(0,Number(i.total_minor)-paid);const status=outstanding===0?'paid':'part_paid';await client.query(`UPDATE customer_invoices SET paid_minor=$1,outstanding_minor=$2,status=$3,amount_due_now_minor=LEAST(COALESCE(amount_due_now_minor,$2),$2),updated_at=now() WHERE id=$4`,[paid,outstanding,status,i.id]);await client.query(`INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details) VALUES($1,$2,'payment_recorded','Sotoboats Admin',jsonb_build_object('amount_minor',to_jsonb($3::bigint),'method',to_jsonb($4::text)))`,[tenant.id,i.id,amount,req.body.method||'bank_transfer']);await client.query('COMMIT');res.redirect(`/invoices/${i.id}`);}catch(err){await client.query('ROLLBACK');res.status(400).send(esc(err.message));}finally{client.release();}
});

app.get('/invoices/:id/pdf',async(req,res)=>{
  try{
    const data=await loadInvoice(req.params.id);
    if(!data)return res.status(404).send('Invoice not found.');
    const i=data.invoice;
    if(!i.locked_at)return res.status(400).send('Issue the invoice before downloading the PDF.');
    const pdf=await buildInvoicePdfBuffer(data);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="Sotoboats-Invoice-${i.invoice_number}.pdf"`);
    res.send(pdf);
  }catch(err){
    console.error(err);
    res.status(500).send(esc(err.message));
  }
});

app.post('/invoices/:id/email',async(req,res)=>{
  const client=await pool.connect();
  try{
    const data=await loadInvoice(req.params.id);
    if(!data) throw new Error('Invoice not found.');
    const {tenant,invoice:i}=data;
    if(!i.locked_at) throw new Error('Issue the invoice before emailing it.');
    if(!i.email) throw new Error('This customer does not have an email address.');

    const transporter=getMailTransporter();

    const pdf=await buildInvoicePdfBuffer(data);
    const from=process.env.SMTP_FROM || tenant.email || process.env.SMTP_USER;
    const subject=`Sotoboats Invoice ${i.invoice_number}`;

    await transporter.sendMail({
      from,
      to:i.email,
      replyTo:tenant.email || undefined,
      subject,
      html:invoiceEmailHtml(data),
      text:`Hello ${i.contact_name||i.company_name||'Customer'},\n\nPlease find attached Sotoboats invoice ${i.invoice_number}.\nBalance due: ${euro(i.outstanding_minor)}\nDue date: ${fmtDate(i.due_date)}\n\nPayment details are included on the attached invoice.\n\nThank you,\nSotoboats`,
      attachments:[{
        filename:`Sotoboats-Invoice-${i.invoice_number}.pdf`,
        content:pdf,
        contentType:'application/pdf'
      }]
    });

    await client.query('BEGIN');
    await client.query(
      `UPDATE customer_invoices SET emailed_at=now(),emailed_to=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3`,
      [i.email,i.id,tenant.id]
    );
    await client.query(
      `INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details)
       VALUES($1,$2,'invoice_emailed','Sotoboats Admin',jsonb_build_object('to',to_jsonb($3::text)))`,
      [tenant.id,i.id,i.email]
    );
    await client.query('COMMIT');
    res.redirect(`/invoices/${i.id}`);
  }catch(err){
    try{await client.query('ROLLBACK');}catch(_){}
    console.error(err);
    res.status(400).send(shell('Email error','invoices',`<section class="card"><h2>Could not send invoice</h2><p class="sub">${esc(err.message)}</p><div class="actions"><a class="btn" href="/invoices/${req.params.id}">Back to invoice</a></div></section>`));
  }finally{
    client.release();
  }
});


app.post('/invoices/:id/remind',async(req,res)=>{
  const client=await pool.connect();
  try{
    const data=await loadInvoice(req.params.id);
    if(!data) throw new Error('Invoice not found.');
    const {tenant,invoice:i}=data;
    if(!i.locked_at) throw new Error('Draft invoices cannot be chased for payment.');
    if(Number(i.outstanding_minor)<=0) throw new Error('This invoice has no outstanding balance.');
    if(!i.email) throw new Error('This customer does not have an email address.');

    const transporter=getMailTransporter();
    const pdf=await buildInvoicePdfBuffer(data);
    const from=process.env.SMTP_FROM||tenant.email||process.env.SMTP_USER;

    await transporter.sendMail({
      from,
      to:i.email,
      replyTo:tenant.email||undefined,
      subject:`Friendly payment reminder – Sotoboats Invoice ${i.invoice_number}`,
      html:paymentReminderHtml(data),
      text:`Hello ${i.contact_name||i.company_name||'Customer'},\n\nJust a friendly reminder that ${euro(i.outstanding_minor)} remains outstanding on Sotoboats invoice ${i.invoice_number}, due ${fmtDate(i.due_date)}.\n\nIf payment has already been made, please disregard this message. Otherwise, the payment details are included on the attached invoice.\n\nMany thanks,\nSotoboats`,
      attachments:[{
        filename:`Sotoboats-Invoice-${i.invoice_number}.pdf`,
        content:pdf,
        contentType:'application/pdf'
      }]
    });

    await client.query('BEGIN');
    await client.query(`
      UPDATE customer_invoices
      SET reminder_sent_at=now(), reminder_count=COALESCE(reminder_count,0)+1, updated_at=now()
      WHERE id=$1 AND tenant_id=$2
    `,[i.id,tenant.id]);
    await client.query(`
      INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details)
      VALUES($1,$2,'payment_reminder_sent','Sotoboats Admin',jsonb_build_object('to',to_jsonb($3::text),'outstanding_minor',to_jsonb($4::bigint)))
    `,[tenant.id,i.id,i.email,Number(i.outstanding_minor)]);
    await client.query('COMMIT');
    res.redirect(`/invoices?filter=${i.status==='overdue'?'overdue':'due'}`);
  }catch(err){
    try{await client.query('ROLLBACK');}catch(_){}
    console.error(err);
    res.status(400).send(shell('Reminder error','invoices',`<section class="card"><h2>Could not send reminder</h2><p class="sub">${esc(err.message)}</p><div class="actions"><a class="btn light" href="/invoices">Back to invoices</a></div></section>`));
  }finally{
    client.release();
  }
});


function creditNoteRowsHtml(items=[]) {
  return items.map((x,idx)=>`<div class="line-grid credit-line-row">
    <div>
      <label>English description<input name="description_en" value="${esc(x.description_en||'')}" required></label>
      <label style="margin-top:6px">English detail<input name="detail_en" value="${esc(x.detail_en||'')}"></label>
    </div>
    <div>
      <label>Spanish description<input name="description_es" value="${esc(x.description_es||'')}"></label>
      <label style="margin-top:6px">Spanish detail<input name="detail_es" value="${esc(x.detail_es||'')}"></label>
    </div>
    <label>Qty<input type="number" min="0" step="0.001" name="quantity" value="${Number(x.quantity||0)}"></label>
    <label>Net unit €<input type="number" min="0" step="0.01" name="unit_price" value="${major(x.unit_price_minor||0).toFixed(2)}"></label>
    <label>VAT<input value="${Number(x.tax_rate).toFixed(0)}%" disabled><input type="hidden" name="tax_rate" value="${Number(x.tax_rate)}"></label>
    <input type="hidden" name="original_item_id" value="${esc(x.original_item_id||x.id||'')}">
  </div>`).join('');
}

function creditNoteForm(data, note=null, noteItems=[]) {
  const {tenant,invoice,items}=data;
  const edit=!!note;
  const rows=edit?noteItems:items.map(x=>({
    original_item_id:x.id,
    description_en:x.description_en,
    description_es:x.description_es,
    detail_en:x.detail_en,
    detail_es:x.detail_es,
    quantity:x.quantity,
    unit_price_minor:x.unit_price_minor,
    tax_rate:x.tax_rate
  }));
  const today=new Date().toISOString().slice(0,10);
  const action=edit?`/credit-notes/${note.id}/edit`:`/invoices/${invoice.id}/credit-note`;
  return `<section class="form-card">
    <div class="actions" style="justify-content:space-between">
      <div>
        <h2>${edit?'Edit credit note draft':'Create credit note'}</h2>
        <p class="sub">Against invoice <strong>${esc(invoice.invoice_number||'')}</strong>. Set quantities to zero for lines you are not crediting.</p>
      </div>
      <a class="btn light" href="/invoices/${invoice.id}">Back to invoice</a>
    </div>
    <form method="post" action="${action}" id="creditNoteForm">
      <div class="form-grid three">
        <label>Issue date<input type="date" name="issue_date" value="${iso(note?.issue_date)||today}" required></label>
        <label>Language<select name="invoice_language"><option value="bilingual" ${note?.invoice_language==='bilingual'||!note?'selected':''}>Bilingual</option><option value="en" ${note?.invoice_language==='en'?'selected':''}>English</option><option value="es" ${note?.invoice_language==='es'?'selected':''}>Spanish</option></select></label>
        <label>Reason<input name="reason" value="${esc(note?.reason||'')}" placeholder="e.g. Booking cancelled / service adjustment" required></label>
        <label class="full">Notes<textarea name="notes">${esc(note?.notes||'')}</textarea></label>
      </div>
      <section class="card" style="margin-top:16px;background:#fbfcfc">
        <h2>Credit lines</h2>
        <div id="creditRows">${creditNoteRowsHtml(rows)}</div>
        <div class="totals">
          <div class="totals-row"><span>Net credit</span><strong id="creditNet">€0.00</strong></div>
          <div class="totals-row"><span>VAT credit</span><strong id="creditVat">€0.00</strong></div>
          <div class="totals-row final"><span>Total credit</span><strong id="creditTotal">€0.00</strong></div>
        </div>
      </section>
      <div class="actions" style="margin-top:15px"><button class="btn gold">Save credit note draft</button></div>
    </form>
  </section>
  <script>
    function calcCredit(){
      let net=0,vat=0;
      document.querySelectorAll('.credit-line-row').forEach(function(r){
        const q=parseFloat(r.querySelector('[name=quantity]').value)||0;
        const p=parseFloat(r.querySelector('[name=unit_price]').value)||0;
        const t=parseFloat(r.querySelector('[name=tax_rate]').value)||0;
        const n=q*p; net+=n; vat+=n*t/100;
      });
      document.getElementById('creditNet').textContent='€'+net.toFixed(2);
      document.getElementById('creditVat').textContent='€'+vat.toFixed(2);
      document.getElementById('creditTotal').textContent='€'+(net+vat).toFixed(2);
    }
    document.getElementById('creditNoteForm').addEventListener('input',calcCredit);
    calcCredit();
  </script>`;
}

async function saveCreditNote(req,res,existingId=null) {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const tenant=await getTenant(client);
    const b=req.body;

    let invoiceId=req.params.id;
    if(existingId){
      const existing=(await client.query(`SELECT * FROM customer_credit_notes WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[existingId,tenant.id])).rows[0];
      if(!existing) throw new Error('Credit note not found.');
      if(existing.locked_at) throw new Error('Issued credit notes are locked.');
      invoiceId=existing.original_invoice_id;
    }

    const invoice=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2`,[invoiceId,tenant.id])).rows[0];
    if(!invoice || !invoice.locked_at) throw new Error('Credit notes can only be created against an issued invoice.');

    const descEn=Array.isArray(b.description_en)?b.description_en:[b.description_en];
    const descEs=Array.isArray(b.description_es)?b.description_es:[b.description_es];
    const detEn=Array.isArray(b.detail_en)?b.detail_en:[b.detail_en];
    const detEs=Array.isArray(b.detail_es)?b.detail_es:[b.detail_es];
    const qty=Array.isArray(b.quantity)?b.quantity:[b.quantity];
    const price=Array.isArray(b.unit_price)?b.unit_price:[b.unit_price];
    const tax=Array.isArray(b.tax_rate)?b.tax_rate:[b.tax_rate];
    const origIds=Array.isArray(b.original_item_id)?b.original_item_id:[b.original_item_id];

    const lines=[];
    for(let n=0;n<descEn.length;n++){
      const q=Number(qty[n]||0);
      if(q<=0) continue;
      const c=calculateLine(q,price[n],tax[n]);
      if(c.total<=0) continue;
      lines.push({
        original_item_id:origIds[n]||null,
        description_en:String(descEn[n]||'').trim(),
        description_es:String(descEs[n]||'').trim()||null,
        detail_en:String(detEn[n]||'').trim()||null,
        detail_es:String(detEs[n]||'').trim()||null,
        tax_rate:Number(tax[n]||0),
        ...c
      });
    }
    if(!lines.length) throw new Error('Credit at least one invoice line.');

    const subtotal=lines.reduce((s,l)=>s+l.net,0);
    const vat=lines.reduce((s,l)=>s+l.tax,0);
    const total=subtotal+vat;

    const alreadyIssued=await issuedCreditsForInvoice(invoice.id,existingId,client);
    const remaining=Math.max(0,Number(invoice.total_minor)-alreadyIssued);
    if(total>remaining) throw new Error(`Credit note exceeds the remaining creditable amount of ${euro(remaining)}.`);

    let creditNoteId=existingId;
    if(existingId){
      await client.query(`
        UPDATE customer_credit_notes SET invoice_language=$1,issue_date=$2,reason=$3,notes=$4,
          subtotal_minor=$5,tax_minor=$6,total_minor=$7,updated_at=now()
        WHERE id=$8 AND tenant_id=$9
      `,[b.invoice_language||'bilingual',b.issue_date||null,b.reason,b.notes||null,subtotal,vat,total,existingId,tenant.id]);
      await client.query(`DELETE FROM customer_credit_note_items WHERE credit_note_id=$1`,[existingId]);
    }else{
      creditNoteId=(await client.query(`
        INSERT INTO customer_credit_notes(
          tenant_id,original_invoice_id,customer_id,invoice_language,issue_date,reason,notes,
          subtotal_minor,tax_minor,total_minor
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
      `,[tenant.id,invoice.id,invoice.customer_id,b.invoice_language||'bilingual',b.issue_date||null,b.reason,b.notes||null,subtotal,vat,total])).rows[0].id;
    }

    for(let n=0;n<lines.length;n++){
      const l=lines[n];
      await client.query(`
        INSERT INTO customer_credit_note_items(
          credit_note_id,original_item_id,sort_order,description_en,description_es,detail_en,detail_es,
          quantity,unit_price_minor,tax_rate,line_net_minor,line_tax_minor,line_total_minor
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,[creditNoteId,l.original_item_id,n,l.description_en,l.description_es,l.detail_en,l.detail_es,l.qty,l.unit,l.tax_rate,l.net,l.tax,l.total]);
    }

    await client.query('COMMIT');
    res.redirect(`/credit-notes/${creditNoteId}`);
  }catch(err){
    await client.query('ROLLBACK');
    res.status(400).send(shell('Credit note error','credit-notes',`<section class="card"><h2>Could not save credit note</h2><p class="sub">${esc(err.message)}</p><div class="actions"><a class="btn light" href="javascript:history.back()">Go back</a></div></section>`));
  }finally{
    client.release();
  }
}

app.get('/invoices/:id/credit-note',async(req,res)=>{
  const data=await loadInvoice(req.params.id);
  if(!data)return res.status(404).send('Invoice not found.');
  if(!data.invoice.locked_at)return res.status(400).send('Issue the invoice first.');
  const issued=await issuedCreditsForInvoice(data.invoice.id);
  if(issued>=Number(data.invoice.total_minor)) return res.status(400).send('This invoice has already been fully credited.');
  res.send(shell('Create Credit Note','credit-notes',creditNoteForm(data),'Credit an issued invoice without altering the original document.'));
});
app.post('/invoices/:id/credit-note',(req,res)=>saveCreditNote(req,res));

app.get('/credit-notes',async(req,res)=>{
  const tenant=await getTenant();
  const rows=(await pool.query(`
    SELECT cn.*,i.invoice_number,c.contact_name,c.company_name
    FROM customer_credit_notes cn
    JOIN customer_invoices i ON i.id=cn.original_invoice_id
    JOIN invoice_customers c ON c.id=cn.customer_id
    WHERE cn.tenant_id=$1
    ORDER BY cn.created_at DESC
  `,[tenant.id])).rows;
  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Credit note</th><th>Original invoice</th><th>Customer</th><th>Reason</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.credit_note_number||'Draft')}</strong><br><span class="muted">${fmtDate(r.issue_date||r.created_at)}</span></td><td><a href="/invoices/${r.original_invoice_id}">${esc(r.invoice_number||'')}</a></td><td>${esc(r.company_name||r.contact_name)}</td><td>${esc(r.reason||'')}</td><td>${euro(r.total_minor)}</td><td>${creditStatusPill(r.status)}</td><td><a class="btn light" href="/credit-notes/${r.id}">Open</a></td></tr>`).join('')}</tbody></table></div>`:'<p class="sub">No credit notes yet.</p>';
  res.send(shell('Credit Notes','credit-notes',`<section class="card"><h2>Credit notes</h2>${table}</section>`,'Corrections and credits linked to issued invoices.'));
});

function creditNotePreview(data){
  const {tenant,note:n,items}=data;
  const showEn=n.invoice_language!=='es',showEs=n.invoice_language!=='en';
  const vatGroups={};items.forEach(x=>{const k=Number(x.tax_rate).toFixed(0);vatGroups[k]=(vatGroups[k]||0)+Number(x.line_tax_minor)});
  const identity=n.identity_number?`<p>${esc(n.identity_type||'ID')}: ${esc(n.identity_number)}</p>`:'';
  const rows=items.map(x=>`<tr><td><strong>${showEn?esc(x.description_en):esc(x.description_es||x.description_en)}</strong>${showEs&&x.description_es?`<br><span class="muted">${esc(x.description_es)}</span>`:''}</td><td>${Number(x.quantity)}</td><td>${euro(x.unit_price_minor)}</td><td>${Number(x.tax_rate).toFixed(0)}%</td><td>-${euro(x.line_total_minor)}</td></tr>`).join('');
  return `<div class="invoice-sheet">
    <div class="invoice-head">
      <div class="invoice-brand"><img src="/sotoboats-logo.png" alt="Sotoboats" style="display:block;width:215px;max-width:100%;height:auto;margin:0 0 10px"><p><strong>${esc(tenant.legal_name)}</strong></p><p>${esc(tenant.address_1||'')} · ${esc(tenant.postcode||'')} ${esc(tenant.city||'')}</p><p>${esc(tenant.region||'')} · ${esc(tenant.country_name||'')}</p><p>${esc(tenant.email||'')} · ${esc(tenant.phone||'')}</p><p>Company ID: ${esc(tenant.tax_id||'')}</p></div>
      <div class="invoice-meta"><strong>Credit Note / Abono ${esc(n.credit_note_number||'DRAFT')}</strong><p>Issue date / Fecha: ${fmtDate(n.issue_date)}</p><p>Original invoice / Factura: ${esc(n.original_invoice_number||'')}</p></div>
    </div>
    <div class="billto"><div><div class="eyebrow">Credit to / Abonar a</div><p><strong>${esc(n.company_name||n.contact_name)}</strong></p>${n.company_name?`<p>${esc(n.contact_name)}</p>`:''}<p>${esc([n.billing_address_1,n.billing_address_2,n.billing_city,n.billing_region,n.billing_postcode].filter(Boolean).join(', '))}</p>${identity}</div><div><div class="eyebrow">Customer / Cliente</div><p>${esc(n.email||'')}</p><p>${esc(n.phone||'')}</p>${n.tax_number?`<p>Tax ID: ${esc(n.tax_number)}</p>`:''}</div></div>
    <h3 class="invoice-title">Credit note for invoice ${esc(n.original_invoice_number||'')}</h3>
    <div class="lang-block"><strong>Reason / Motivo:</strong> ${esc(n.reason||'')}</div>
    <table class="invoice-table"><thead><tr><th>Product or Service</th><th>Qty</th><th>Net</th><th>VAT</th><th>Credit</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="invoice-summary">
      <div class="summary-row"><span>Net credit</span><strong>-${euro(n.subtotal_minor)}</strong></div>
      ${Object.entries(vatGroups).sort((a,b)=>Number(a[0])-Number(b[0])).map(([rate,amt])=>`<div class="summary-row"><span>IVA / VAT ${rate}%</span><strong>-${euro(amt)}</strong></div>`).join('')}
      <div class="summary-row final"><span>Total credit</span><strong>-${euro(n.total_minor)}</strong></div>
    </div>
    ${n.notes?`<div class="lang-block"><strong>Notes</strong><p>${esc(n.notes)}</p></div>`:''}
  </div>`;
}

function buildCreditNotePdfBuffer(data){
  return new Promise((resolve,reject)=>{
    try{
      const {tenant,note:n,items}=data;
      const chunks=[];
      const doc=new PDFDocument({size:'A4',margin:45});
      doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
      const navy='#0b1d2f',gold='#caa86d',muted='#667783';
      const logoPath=path.join(__dirname,'public','sotoboats-logo.png');
      if(fs.existsSync(logoPath))doc.image(logoPath,45,42,{width:215});else doc.fillColor(navy).font('Helvetica-Bold').fontSize(25).text('SOTOBOATS',45,45);
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(`${tenant.legal_name}\n${tenant.address_1||''}\n${tenant.postcode||''} ${tenant.city||''}, ${tenant.region||''}\n${tenant.country_name||''}\n${tenant.email||''} · ${tenant.phone||''}\nCompany ID: ${tenant.tax_id||''}`,45,90,{width:250});
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(14).text(`Credit Note / Abono ${n.credit_note_number}`,330,48,{width:220,align:'right'});
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(`Issue date: ${fmtDate(n.issue_date)}\nOriginal invoice: ${n.original_invoice_number}`,330,72,{width:220,align:'right'});
      doc.moveTo(45,150).lineTo(550,150).strokeColor('#dce3e6').stroke();
      doc.fillColor(gold).font('Helvetica-Bold').fontSize(8).text('CREDIT TO / ABONAR A',45,166);
      doc.fillColor(navy).fontSize(10).text(n.company_name||n.contact_name,45,180);
      const lines=[
        n.company_name?n.contact_name:null,
        [n.billing_address_1,n.billing_address_2,n.billing_city,n.billing_region,n.billing_postcode].filter(Boolean).join(', '),
        n.identity_number?`${n.identity_type||'ID'}: ${n.identity_number}`:null,
        n.email||null,n.phone||null
      ].filter(Boolean).join('\n');
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(lines,45,195,{width:250});
      let y=250;
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(14).text(`Credit note for invoice ${n.original_invoice_number}`,45,y,{width:505});y+=25;
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(`Reason: ${n.reason}`,45,y,{width:505});y+=25;
      doc.rect(45,y,505,24).fill('#e7eef5');doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('Product or Service',53,y+8);doc.text('Qty',335,y+8);doc.text('Net',380,y+8);doc.text('VAT',435,y+8);doc.text('Credit',485,y+8);y+=30;
      for(const item of items){
        const label=[item.description_en,n.invoice_language!=='en'&&item.description_es?item.description_es:null].filter(Boolean).join(' / ');
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text(label,53,y,{width:265});
        doc.fillColor(navy).font('Helvetica').fontSize(8).text(String(Number(item.quantity)),337,y);doc.text(euro(item.unit_price_minor),376,y);doc.text(`${Number(item.tax_rate).toFixed(0)}%`,438,y);doc.text('-'+euro(item.line_total_minor),482,y);
        y+=35;if(y>650){doc.addPage();y=55;}
      }
      y+=10;doc.moveTo(330,y).lineTo(550,y).strokeColor('#dce3e6').stroke();y+=12;
      doc.fillColor(navy).font('Helvetica').fontSize(8).text('Net credit',335,y);doc.text('-'+euro(n.subtotal_minor),465,y,{width:75,align:'right'});y+=20;
      doc.text('VAT credit',335,y);doc.text('-'+euro(n.tax_minor),465,y,{width:75,align:'right'});y+=20;
      doc.rect(325,y-4,225,24).fill('#eef4f7');doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text('Total credit',335,y);doc.text('-'+euro(n.total_minor),465,y,{width:75,align:'right'});
      doc.end();
    }catch(err){reject(err);}
  });
}

app.get('/credit-notes/:id',async(req,res)=>{
  const data=await loadCreditNote(req.params.id);
  if(!data)return res.status(404).send('Credit note not found.');
  const n=data.note;
  const emailBtn=n.locked_at&&n.email?`<form method="post" action="/credit-notes/${n.id}/email"><button class="btn gold">${n.emailed_at?'Resend credit note':'Send credit note'}</button></form>`:'';
  const controls=`<div class="actions no-print" style="margin-bottom:15px">${!n.locked_at?`<a class="btn light" href="/credit-notes/${n.id}/edit">Edit draft</a><form method="post" action="/credit-notes/${n.id}/issue" onsubmit="return confirm('Issue this credit note? Once issued it will be locked and the original invoice balance will be adjusted.');"><button class="btn gold">Issue credit note</button></form>`:`<a class="btn light" target="_blank" href="/credit-notes/${n.id}/pdf">Download PDF</a>${emailBtn}`}<a class="btn light" href="/invoices/${n.original_invoice_id}">Original invoice</a><a class="btn light" href="/credit-notes">Back to credit notes</a></div>`;
  res.send(shell(n.credit_note_number||'Draft Credit Note','credit-notes',`${controls}${creditNotePreview(data)}`,n.locked_at?'Issued credit notes are locked.':'Draft credit note — still editable.'));
});

app.get('/credit-notes/:id/edit',async(req,res)=>{
  const cn=await loadCreditNote(req.params.id);
  if(!cn)return res.status(404).send('Credit note not found.');
  if(cn.note.locked_at)return res.redirect(`/credit-notes/${cn.note.id}`);
  const invoiceData=await loadInvoice(cn.note.original_invoice_id);
  res.send(shell('Edit Credit Note','credit-notes',creditNoteForm(invoiceData,cn.note,cn.items),'Edit before issuing.'));
});
app.post('/credit-notes/:id/edit',(req,res)=>saveCreditNote(req,res,req.params.id));

app.post('/credit-notes/:id/issue',async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const tenant=await getTenant(client);
    const cn=(await client.query(`SELECT * FROM customer_credit_notes WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[req.params.id,tenant.id])).rows[0];
    if(!cn)throw new Error('Credit note not found.');
    if(cn.locked_at)throw new Error('Credit note has already been issued.');
    const invoice=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[cn.original_invoice_id,tenant.id])).rows[0];
    if(!invoice)throw new Error('Original invoice not found.');

    const otherCredits=await issuedCreditsForInvoice(invoice.id,cn.id,client);
    if(otherCredits+Number(cn.total_minor)>Number(invoice.total_minor))throw new Error('This credit would exceed the original invoice total.');

    const customer=(await client.query(`SELECT * FROM invoice_customers WHERE id=$1 AND tenant_id=$2`,[cn.customer_id,tenant.id])).rows[0];
    const t=(await client.query(`SELECT * FROM invoice_tenants WHERE id=$1 FOR UPDATE`,[tenant.id])).rows[0];
    const number=`${t.credit_note_prefix||'CN-'}${String(t.next_credit_note_number||1).padStart(Number(t.credit_note_padding||6),'0')}`;
    const issue=cn.issue_date||new Date().toISOString().slice(0,10);

    await client.query(`
      UPDATE customer_credit_notes SET
        credit_note_number=$1,status='issued',issue_date=$2,issued_at=now(),locked_at=now(),updated_at=now(),
        snapshot_contact_name=$3,snapshot_company_name=$4,snapshot_email=$5,snapshot_phone=$6,
        snapshot_billing_address_1=$7,snapshot_billing_address_2=$8,snapshot_billing_city=$9,
        snapshot_billing_region=$10,snapshot_billing_postcode=$11,snapshot_billing_country_code=$12,
        snapshot_tax_number=$13,snapshot_identity_type=$14,snapshot_identity_number=$15
      WHERE id=$16
    `,[number,issue,customer.contact_name||null,customer.company_name||null,customer.email||null,customer.phone||null,customer.billing_address_1||null,customer.billing_address_2||null,customer.billing_city||null,customer.billing_region||null,customer.billing_postcode||null,customer.billing_country_code||null,customer.tax_number||null,customer.identity_type||null,customer.identity_number||null,cn.id]);

    await client.query(`UPDATE invoice_tenants SET next_credit_note_number=next_credit_note_number+1,updated_at=now() WHERE id=$1`,[tenant.id]);

    const credits=otherCredits+Number(cn.total_minor);
    const outstanding=Math.max(0,Number(invoice.total_minor)-Number(invoice.paid_minor)-credits);
    let status=invoice.status;
    if(credits>=Number(invoice.total_minor))status='credited';
    else if(outstanding===0&&Number(invoice.paid_minor)>0)status='paid';
    else if(Number(invoice.paid_minor)>0||credits>0)status='part_paid';
    else status=invoice.due_date&&dateYmd(invoice.due_date)<new Date().toISOString().slice(0,10)?'overdue':'sent';

    await client.query(`
      UPDATE customer_invoices
      SET credited_minor=$1,outstanding_minor=$2,amount_due_now_minor=LEAST(COALESCE(amount_due_now_minor,$2),$2),status=$3,updated_at=now()
      WHERE id=$4
    `,[credits,outstanding,status,invoice.id]);

    await client.query(`
      INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details)
      VALUES($1,$2,'credit_note_issued','Sotoboats Admin',
        jsonb_build_object('credit_note_number',to_jsonb($3::text),'credit_minor',to_jsonb($4::bigint)))
    `,[tenant.id,invoice.id,number,Number(cn.total_minor)]);

    await client.query('COMMIT');
    res.redirect(`/credit-notes/${cn.id}`);
  }catch(err){
    await client.query('ROLLBACK');
    res.status(400).send(shell('Credit note error','credit-notes',`<section class="card"><h2>Could not issue credit note</h2><p class="sub">${esc(err.message)}</p><a class="btn light" href="/credit-notes/${req.params.id}">Back</a></section>`));
  }finally{client.release();}
});

app.get('/credit-notes/:id/pdf',async(req,res)=>{
  try{
    const data=await loadCreditNote(req.params.id);
    if(!data)return res.status(404).send('Credit note not found.');
    if(!data.note.locked_at)return res.status(400).send('Issue the credit note before downloading the PDF.');
    const pdf=await buildCreditNotePdfBuffer(data);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="Sotoboats-Credit-Note-${data.note.credit_note_number}.pdf"`);
    res.send(pdf);
  }catch(err){console.error(err);res.status(500).send(esc(err.message));}
});

app.post('/credit-notes/:id/email',async(req,res)=>{
  const client=await pool.connect();
  try{
    const data=await loadCreditNote(req.params.id);
    if(!data)throw new Error('Credit note not found.');
    const {tenant,note:n}=data;
    if(!n.locked_at)throw new Error('Issue the credit note before emailing it.');
    if(!n.email)throw new Error('Customer does not have an email address.');
    const transporter=getMailTransporter();
    const pdf=await buildCreditNotePdfBuffer(data);
    await transporter.sendMail({
      from:process.env.SMTP_FROM||tenant.email||process.env.SMTP_USER,
      to:n.email,
      replyTo:tenant.email||undefined,
      subject:`Sotoboats Credit Note ${n.credit_note_number}`,
      html:`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2>Sotoboats Credit Note ${esc(n.credit_note_number)}</h2><p>Hello ${esc(n.contact_name||n.company_name||'Customer')},</p><p>Please find attached credit note <strong>${esc(n.credit_note_number)}</strong> relating to invoice <strong>${esc(n.original_invoice_number)}</strong>.</p><p><strong>Total credit: ${euro(n.total_minor)}</strong></p><p>Many thanks,<br>Sotoboats</p></div>`,
      text:`Hello ${n.contact_name||n.company_name||'Customer'},\n\nPlease find attached credit note ${n.credit_note_number} relating to invoice ${n.original_invoice_number}.\nTotal credit: ${euro(n.total_minor)}\n\nMany thanks,\nSotoboats`,
      attachments:[{filename:`Sotoboats-Credit-Note-${n.credit_note_number}.pdf`,content:pdf,contentType:'application/pdf'}]
    });
    await client.query('BEGIN');
    await client.query(`UPDATE customer_credit_notes SET emailed_at=now(),emailed_to=$1,updated_at=now() WHERE id=$2`,[n.email,n.id]);
    await client.query('COMMIT');
    res.redirect(`/credit-notes/${n.id}`);
  }catch(err){
    try{await client.query('ROLLBACK');}catch(_){}
    res.status(400).send(shell('Credit note email error','credit-notes',`<section class="card"><h2>Could not send credit note</h2><p class="sub">${esc(err.message)}</p><a class="btn light" href="/credit-notes/${req.params.id}">Back</a></section>`));
  }finally{client.release();}
});


app.get('/month-end',async(req,res)=>{
  const tenant=await getTenant();
  const today=new Date();
  const defaultMonth=`${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,'0')}`;
  const month=normaliseMonth(req.query.month)||defaultMonth;
  const income=await monthEndIncomeRows(tenant.id,month);
  const credits=await monthEndCreditRows(tenant.id,month);

  const received=income.reduce((s,r)=>s+Number(r.received_in_month_minor||0),0);
  const invoiceCount=income.length;
  const creditTotal=credits.reduce((s,r)=>s+Number(r.total_minor||0),0);

  const incomeTable=income.length?`<div class="table-wrap"><table>
    <thead><tr><th>Invoice</th><th>Customer</th><th>Payment date(s)</th><th>Invoice total</th><th>Received this month</th><th>Method</th><th>Outstanding</th><th></th></tr></thead>
    <tbody>${income.map(r=>`<tr>
      <td><strong>${esc(r.invoice_number||'')}</strong><br><span class="muted">${fmtDate(r.issue_date)}</span></td>
      <td><strong>${esc(r.company_name||r.contact_name||'')}</strong><br><span class="muted">${esc(r.email||'')}</span></td>
      <td>${fmtDate(r.first_payment_in_month)}${String(r.first_payment_in_month)!==String(r.last_payment_in_month)?` – ${fmtDate(r.last_payment_in_month)}`:''}</td>
      <td>${euro(r.total_minor)}</td>
      <td><strong>${euro(r.received_in_month_minor)}</strong></td>
      <td>${esc(r.payment_methods||'—')}</td>
      <td>${euro(r.outstanding_minor)}</td>
      <td><a class="btn light" href="/invoices/${r.invoice_id}">Open</a></td>
    </tr>`).join('')}</tbody></table></div>`:'<p class="sub">No payments were recorded in this month.</p>';

  const creditTable=credits.length?`<div class="table-wrap"><table>
    <thead><tr><th>Credit note</th><th>Original invoice</th><th>Customer</th><th>Date</th><th>Reason</th><th>Total credit</th><th></th></tr></thead>
    <tbody>${credits.map(r=>`<tr>
      <td><strong>${esc(r.credit_note_number||'')}</strong></td>
      <td>${esc(r.original_invoice_number||'')}</td>
      <td>${esc(r.company_name||r.contact_name||'')}</td>
      <td>${fmtDate(r.issue_date)}</td>
      <td>${esc(r.reason||'')}</td>
      <td>${euro(r.total_minor)}</td>
      <td><a class="btn light" href="/credit-notes/${r.credit_note_id}">Open</a></td>
    </tr>`).join('')}</tbody></table></div>`:'<p class="sub">No credit notes were issued in this month.</p>';

  const content=`<section class="card">
    <div class="actions" style="justify-content:space-between;align-items:end">
      <div><h2 style="margin:0">Accountant / Month End</h2><p class="sub" style="margin:5px 0 0">Income is grouped by the date payment was actually received.</p></div>
      <form method="get" action="/month-end" class="actions" style="align-items:end">
        <label>Month<input type="month" name="month" value="${esc(month)}"></label>
        <button class="btn gold">Load month</button>
      </form>
    </div>
  </section>

  <div class="metrics">
    <div class="metric"><small>Payments received</small><strong>${euro(received)}</strong></div>
    <div class="metric"><small>Invoices paid into</small><strong>${invoiceCount}</strong></div>
    <div class="metric"><small>Credit notes issued</small><strong>${credits.length}</strong></div>
    <div class="metric"><small>Credit total</small><strong>${euro(creditTotal)}</strong></div>
  </div>

  <section class="card">
    <div class="actions" style="justify-content:space-between;margin-bottom:12px">
      <div><h2 style="margin:0">Payments received — ${esc(monthLabel(month))}</h2><p class="sub" style="margin:4px 0 0">Partial payments count only the amount received during this month.</p></div>
      <div class="actions">
        <a class="btn light" href="/month-end/income.csv?month=${encodeURIComponent(month)}">Download CSV</a>
        <a class="btn gold" href="/month-end/accountant-pack.zip?month=${encodeURIComponent(month)}">Download accountant pack</a>
      </div>
    </div>
    ${incomeTable}
  </section>

  <section class="card">
    <div class="actions" style="justify-content:space-between;margin-bottom:12px">
      <div><h2 style="margin:0">Credit notes issued — ${esc(monthLabel(month))}</h2><p class="sub" style="margin:4px 0 0">Included separately so the accountant can see corrections against original invoices.</p></div>
      ${credits.length?`<a class="btn light" href="/month-end/credit-notes.csv?month=${encodeURIComponent(month)}">Download credit-note CSV</a>`:''}
    </div>
    ${creditTable}
  </section>

  <section class="card">
    <h2>Expenses</h2>
    <p class="sub">The expense-scanning inbox will sit here next: upload receipts/invoices → extract supplier/date/net/VAT/gross → review → include in the same accountant pack.</p>
  </section>`;

  res.send(shell(`Month End – ${monthLabel(month)}`,'month-end',content,'Monthly accountant pack based on real receipts of payment.'));
});

app.get('/month-end/income.csv',async(req,res)=>{
  const tenant=await getTenant();
  const month=normaliseMonth(req.query.month);
  if(!month)return res.status(400).send('Choose a valid month.');
  const rows=await monthEndIncomeRows(tenant.id,month);
  const csv=monthEndIncomeCsv(rows,month);
  res.type('text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="Sotoboats-Income-${month}.csv"`);
  res.send('\uFEFF'+csv);
});

app.get('/month-end/credit-notes.csv',async(req,res)=>{
  const tenant=await getTenant();
  const month=normaliseMonth(req.query.month);
  if(!month)return res.status(400).send('Choose a valid month.');
  const rows=await monthEndCreditRows(tenant.id,month);
  const csv=monthEndCreditsCsv(rows,month);
  res.type('text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="Sotoboats-Credit-Notes-${month}.csv"`);
  res.send('\uFEFF'+csv);
});

app.get('/month-end/accountant-pack.zip',async(req,res)=>{
  try{
    const tenant=await getTenant();
    const month=normaliseMonth(req.query.month);
    if(!month)return res.status(400).send('Choose a valid month.');

    const income=await monthEndIncomeRows(tenant.id,month);
    const credits=await monthEndCreditRows(tenant.id,month);

    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="Sotoboats-Accountant-Pack-${month}.zip"`);

    const archive=archiver('zip',{zlib:{level:9}});
    archive.on('error',err=>{throw err;});
    archive.pipe(res);

    archive.append('\uFEFF'+monthEndIncomeCsv(income,month),{name:`Sotoboats-Income-${month}.csv`});
    if(credits.length)archive.append('\uFEFF'+monthEndCreditsCsv(credits,month),{name:`Sotoboats-Credit-Notes-${month}.csv`});

    const summaryLines=[
      `Sotoboats Accountant Pack – ${monthLabel(month)}`,
      '',
      `Payments received: ${euro(income.reduce((s,r)=>s+Number(r.received_in_month_minor||0),0))}`,
      `Invoices with payments: ${income.length}`,
      `Credit notes issued: ${credits.length}`,
      `Credit-note total: ${euro(credits.reduce((s,r)=>s+Number(r.total_minor||0),0))}`,
      '',
      'Income selection basis: payment received date.',
      'Partial payments are included only for the amount received during the selected month.',
      'Invoice PDFs are included once per invoice that received at least one payment in the selected month.',
      'Credit-note PDFs are included for credit notes issued in the selected month.'
    ];
    archive.append(summaryLines.join('\n'),{name:`README-${month}.txt`});

    for(const row of income){
      const data=await loadInvoice(row.invoice_id);
      if(!data||!data.invoice.locked_at)continue;
      const pdf=await buildInvoicePdfBuffer(data);
      const safeNo=String(data.invoice.invoice_number||row.invoice_id).replace(/[^a-zA-Z0-9._-]/g,'_');
      archive.append(pdf,{name:`Invoices/Sotoboats-Invoice-${safeNo}.pdf`});
    }

    for(const row of credits){
      const data=await loadCreditNote(row.credit_note_id);
      if(!data||!data.note.locked_at)continue;
      const pdf=await buildCreditNotePdfBuffer(data);
      const safeNo=String(data.note.credit_note_number||row.credit_note_id).replace(/[^a-zA-Z0-9._-]/g,'_');
      archive.append(pdf,{name:`Credit Notes/Sotoboats-Credit-Note-${safeNo}.pdf`});
    }

    await archive.finalize();
  }catch(err){
    console.error(err);
    if(!res.headersSent)res.status(500).send(esc(err.message));
    else res.end();
  }
});

app.get('/settings',async(req,res)=>{
  const t=await getTenant();
  const content=`<section class="form-card"><h2>Company & invoice settings</h2><form method="post" action="/settings"><div class="form-grid"><label>Trading name<input name="trading_name" value="${esc(t.trading_name)}" required></label><label>Legal entity<input name="legal_name" value="${esc(t.legal_name)}" required></label><label>Company / VAT ID<input name="tax_id" value="${esc(t.tax_id||'')}"></label><label>Invoice contact email<input type="email" name="email" value="${esc(t.email||'')}"></label><label>Phone<input name="phone" value="${esc(t.phone||'')}"></label><label>Website<input name="website" value="${esc(t.website||'')}"></label><label>Address<input name="address_1" value="${esc(t.address_1||'')}"></label><label>Postcode<input name="postcode" value="${esc(t.postcode||'')}"></label><label>City<input name="city" value="${esc(t.city||'')}"></label><label>Region<input name="region" value="${esc(t.region||'')}"></label><label>Invoice prefix<input name="invoice_prefix" value="${esc(t.invoice_prefix||'')}" placeholder="Blank keeps 0001575 style"></label><label>Next invoice number<input type="number" min="1" name="next_invoice_number" value="${Number(t.next_invoice_number)}"></label><label>Payment terms days<input type="number" min="0" name="payment_terms_days" value="${Number(t.payment_terms_days)}"></label><label>Default language<select name="default_language"><option value="bilingual" ${t.default_language==='bilingual'?'selected':''}>Bilingual</option><option value="en" ${t.default_language==='en'?'selected':''}>English</option><option value="es" ${t.default_language==='es'?'selected':''}>Spanish</option></select></label><label>Deposit %<input type="number" step="0.01" min="0" max="100" name="deposit_percent" value="${Number(t.deposit_percent)}"></label><label>Deposit threshold days<input type="number" min="0" name="deposit_threshold_days" value="${Number(t.deposit_threshold_days)}"></label><label>Bank account name<input name="bank_account_name" value="${esc(t.bank_account_name||'')}"></label><label>Bank name<input name="bank_name" value="${esc(t.bank_name||'')}"></label><label>IBAN<input name="bank_iban" value="${esc(t.bank_iban||'')}"></label><label>BIC / SWIFT<input name="bank_bic" value="${esc(t.bank_bic||'')}"></label><label class="full">English footer<textarea name="english_footer">${esc(t.english_footer||'')}</textarea></label><label class="full">Spanish footer<textarea name="spanish_footer">${esc(t.spanish_footer||'')}</textarea></label></div><div class="notice" style="margin-top:12px">The next invoice number is seeded at <strong>0001575</strong> to follow the current invoice #0001574. Change this only if Dave confirms a different active series.</div><div class="actions" style="margin-top:14px"><button class="btn gold">Save settings</button></div></form></section>`;
  res.send(shell('Company Settings','settings',content,'Legal entity, trading name, numbering, deposit rules and bank details.'));
});
app.post('/settings',async(req,res)=>{
  const t=await getTenant();const b=req.body;
  await pool.query(`UPDATE invoice_tenants SET trading_name=$1,legal_name=$2,tax_id=$3,email=$4,phone=$5,website=$6,address_1=$7,postcode=$8,city=$9,region=$10,invoice_prefix=$11,next_invoice_number=$12,payment_terms_days=$13,default_language=$14,deposit_percent=$15,deposit_threshold_days=$16,bank_account_name=$17,bank_name=$18,bank_iban=$19,bank_bic=$20,english_footer=$21,spanish_footer=$22,updated_at=now() WHERE id=$23`,[b.trading_name,b.legal_name,b.tax_id||null,b.email||null,b.phone||null,b.website||null,b.address_1||null,b.postcode||null,b.city||null,b.region||null,b.invoice_prefix||'',Number(b.next_invoice_number||1),Number(b.payment_terms_days||0),b.default_language||'bilingual',Number(b.deposit_percent||0),Number(b.deposit_threshold_days||0),b.bank_account_name||null,b.bank_name||null,b.bank_iban||null,b.bank_bic||null,b.english_footer||null,b.spanish_footer||null,t.id]);
  res.redirect('/settings');
});

app.get('/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'Sotoboats Invoicing v1'});}catch(err){res.status(500).json({ok:false,error:err.message});}});

app.use((err,req,res,next)=>{console.error(err);res.status(500).send(shell('Error','',`<section class="card"><h2>Something went wrong</h2><p class="sub">${esc(err.message||'Unknown error')}</p></section>`));});

async function initialiseDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await pool.query(`
    ALTER TABLE customer_invoices
      ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS emailed_to TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_contact_name TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_company_name TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_email TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_phone TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_address_1 TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_address_2 TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_city TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_region TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_postcode TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_billing_country_code TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_tax_number TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_identity_type TEXT,
      ADD COLUMN IF NOT EXISTS snapshot_identity_number TEXT,
      ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS credited_minor BIGINT NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE invoice_tenants
      ADD COLUMN IF NOT EXISTS credit_note_prefix TEXT NOT NULL DEFAULT 'CN-',
      ADD COLUMN IF NOT EXISTS credit_note_padding INTEGER NOT NULL DEFAULT 6,
      ADD COLUMN IF NOT EXISTS next_credit_note_number INTEGER NOT NULL DEFAULT 1;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_credit_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES invoice_tenants(id) ON DELETE CASCADE,
      original_invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
      customer_id UUID NOT NULL REFERENCES invoice_customers(id),
      credit_note_number TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
      invoice_language TEXT NOT NULL DEFAULT 'bilingual' CHECK (invoice_language IN ('en','es','bilingual')),
      issue_date DATE,
      reason TEXT NOT NULL,
      notes TEXT,
      subtotal_minor BIGINT NOT NULL DEFAULT 0,
      tax_minor BIGINT NOT NULL DEFAULT 0,
      total_minor BIGINT NOT NULL DEFAULT 0,
      issued_at TIMESTAMPTZ,
      locked_at TIMESTAMPTZ,
      emailed_at TIMESTAMPTZ,
      emailed_to TEXT,
      snapshot_contact_name TEXT,
      snapshot_company_name TEXT,
      snapshot_email TEXT,
      snapshot_phone TEXT,
      snapshot_billing_address_1 TEXT,
      snapshot_billing_address_2 TEXT,
      snapshot_billing_city TEXT,
      snapshot_billing_region TEXT,
      snapshot_billing_postcode TEXT,
      snapshot_billing_country_code TEXT,
      snapshot_tax_number TEXT,
      snapshot_identity_type TEXT,
      snapshot_identity_number TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_credit_note_number_unique
      ON customer_credit_notes(tenant_id, credit_note_number) WHERE credit_note_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_customer_credit_notes_invoice
      ON customer_credit_notes(original_invoice_id, status);

    CREATE TABLE IF NOT EXISTS customer_credit_note_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_id UUID NOT NULL REFERENCES customer_credit_notes(id) ON DELETE CASCADE,
      original_item_id UUID REFERENCES customer_invoice_items(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      description_en TEXT NOT NULL,
      description_es TEXT,
      detail_en TEXT,
      detail_es TEXT,
      quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
      unit_price_minor BIGINT NOT NULL DEFAULT 0,
      tax_rate NUMERIC(7,4) NOT NULL DEFAULT 21.0000,
      line_net_minor BIGINT NOT NULL DEFAULT 0,
      line_tax_minor BIGINT NOT NULL DEFAULT 0,
      line_total_minor BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_credit_note_items_note
      ON customer_credit_note_items(credit_note_id, sort_order);
  `);

  console.log('Sotoboats invoicing database schema checked / initialised.');
}

async function startApp() {
  try {
    await initialiseDatabase();
    app.listen(PORT, () => console.log(`Sotoboats Invoicing v1 running on port ${PORT}`));
  } catch (err) {
    console.error('Database startup initialisation failed:', err);
    process.exit(1);
  }
}

startApp();
