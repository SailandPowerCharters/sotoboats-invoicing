require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
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
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(`${String(v).slice(0,10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const iso = (v) => v ? String(v).slice(0,10) : '';

async function getTenant(client = pool) {
  const { rows } = await client.query(`SELECT * FROM invoice_tenants WHERE code='SOTOBOATS' LIMIT 1`);
  if (!rows[0]) throw new Error('Sotoboats tenant is missing. Database startup initialisation did not complete.');
  return rows[0];
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
    SELECT i.*, c.contact_name,c.company_name,c.email,c.phone,c.billing_address_1,c.billing_address_2,
           c.billing_city,c.billing_region,c.billing_postcode,c.billing_country_code,c.tax_number,
           c.identity_type,c.identity_number
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

const nav = (active) => `
  <aside class="side">
    <div class="brand"><span class="mark">S</span><div><strong>SOTOBOATS</strong><small>INVOICING · YDP PILOT</small></div></div>
    <nav>
      <a class="${active==='dashboard'?'active':''}" href="/">Dashboard</a>
      <a class="${active==='invoices'?'active':''}" href="/invoices">Invoices</a>
      <a class="${active==='customers'?'active':''}" href="/customers">Customers</a>
      <a class="${active==='settings'?'active':''}" href="/settings">Company Settings</a>
    </nav>
    <div class="side-foot">Marbella Sailing School S.L.<br>trading as Sotoboats<br><br><a href="/logout">Sign out →</a></div>
  </aside>
  .preset-wrap{display:grid;grid-template-columns:1fr 110px 1fr 1fr;gap:8px;margin-bottom:8px}
  .preset-wrap .hours-wrap,.preset-wrap .from-wrap,.preset-wrap .to-wrap{display:none}
  .preset-wrap.show-hours .hours-wrap{display:grid}
  .preset-wrap.show-route .from-wrap,.preset-wrap.show-route .to-wrap{display:grid}
`;

function shell(title, active, content, subtitle='') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} | Sotoboats Invoicing</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Playfair+Display:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css"></head><body><div class="layout">${nav(active)}<main class="main">
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

app.get('/customers',async(req,res)=>{
  const tenant=await getTenant();
  const rows=(await pool.query(`SELECT * FROM invoice_customers WHERE tenant_id=$1 AND is_active=true ORDER BY COALESCE(company_name,contact_name),contact_name`,[tenant.id])).rows;
  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Contact</th><th>Billing</th><th>Tax / ID</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.company_name||r.contact_name)}</strong>${r.company_name?`<br><span class="muted">${esc(r.contact_name)}</span>`:''}</td><td>${esc(r.email||'—')}<br><span class="muted">${esc(r.phone||'')}</span></td><td>${esc([r.billing_address_1,r.billing_city,r.billing_postcode].filter(Boolean).join(', ')||'—')}</td><td>${esc(r.tax_number||'—')}${r.identity_number?`<br><span class="muted">${esc(r.identity_type||'ID')}: ••••${esc(String(r.identity_number).slice(-4))}</span>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="sub">No customers yet.</p>';
  const content=`<section class="form-card"><h2>Add customer</h2><form method="post" action="/customers"><div class="form-grid"><label>Customer type<select name="customer_type"><option value="individual">Individual</option><option value="business">Business</option></select></label><label>Contact name<input name="contact_name" required></label><label>Company name<input name="company_name"></label><label>Email<input type="email" name="email"></label><label>Phone<input name="phone"></label><label>Tax / VAT number<input name="tax_number"></label><label>Address<input name="billing_address_1"></label><label>Address line 2<input name="billing_address_2"></label><label>Town / City<input name="billing_city"></label><label>Region<input name="billing_region"></label><label>Postcode<input name="billing_postcode"></label><label>Country code<input name="billing_country_code" value="ES" maxlength="2"></label><label>Passport / ID type<input name="identity_type" placeholder="Optional"></label><label>Passport / ID number<input name="identity_number" placeholder="Optional"></label><label class="full">Internal notes<textarea name="notes"></textarea></label></div><div class="actions"><button class="btn gold">Save customer</button></div></form></section><section class="card"><h2>Customers</h2>${table}</section>`;
  res.send(shell('Customers','customers',content,'Reusable customer records for future invoices.'));
});
app.post('/customers',async(req,res)=>{
  const tenant=await getTenant(); const b=req.body;
  await pool.query(`INSERT INTO invoice_customers(tenant_id,customer_type,company_name,contact_name,email,phone,billing_address_1,billing_address_2,billing_city,billing_region,billing_postcode,billing_country_code,tax_number,identity_type,identity_number,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[tenant.id,b.customer_type||'individual',b.company_name||null,b.contact_name,b.email||null,b.phone||null,b.billing_address_1||null,b.billing_address_2||null,b.billing_city||null,b.billing_region||null,b.billing_postcode||null,(b.billing_country_code||'ES').toUpperCase().slice(0,2),b.tax_number||null,b.identity_type||null,b.identity_number||null,b.notes||null]);
  res.redirect('/customers');
});

app.get('/invoices',async(req,res)=>{
  const tenant=await getTenant();
  const rows=(await pool.query(`SELECT i.*,c.contact_name,c.company_name FROM customer_invoices i JOIN invoice_customers c ON c.id=i.customer_id WHERE i.tenant_id=$1 ORDER BY i.created_at DESC`,[tenant.id])).rows;
  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Service</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.invoice_number||'Draft')}</strong><br><span class="muted">${fmtDate(r.issue_date||r.created_at)}</span></td><td>${esc(r.company_name||r.contact_name)}</td><td>${esc(r.service_title||'—')}</td><td>${euro(r.total_minor)}</td><td>${euro(r.paid_minor)}</td><td>${euro(r.outstanding_minor)}</td><td>${statusPill(r.status)}</td><td><a class="btn light" href="/invoices/${r.id}">Open</a></td></tr>`).join('')}</tbody></table></div>`:'<p class="sub">No invoices yet.</p>';
  res.send(shell('Invoices','invoices',`<section class="card"><div class="actions" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">All invoices</h2><a class="btn gold" href="/invoices/new">Create invoice</a></div>${table}</section>`,'Draft, issue, track and reconcile Sotoboats invoices.'));
});

function lineRowsHtml(items=[]) {
  const rows=items.length?items:[{description_en:'',description_es:'',detail_en:'',detail_es:'',quantity:1,unit_price_minor:0,tax_rate:21}];
  const presetOptions=`
    <option value="">Choose a description…</option>
    <option value="tuition">Private sailing tuition</option>
    <option value="sunseeker">Charter – Sunseeker</option>
    <option value="catamaran">Charter – Catamaran</option>
    <option value="jeanneau">Charter – Jeanneau sail boat</option>
    <option value="morocco_tuition">Morocco sailing trip – Sailing tuition</option>
    <option value="morocco_subsistence">Morocco sailing trip – Subsistence / cleaning / onboard facilities</option>
    <option value="subsistence">Subsistence / cleaning / onboard facilities</option>
    <option value="delivery">Boat delivery</option>
    <option value="custom">Other / Custom description</option>`;
  return rows.map((i,idx)=>`<div class="line-grid line-row">
    <div style="grid-column:1/-1">
      <div class="preset-wrap">
        <label>Description template<select class="description-preset">${presetOptions}</select></label>
        <label class="hours-wrap">Hours<input class="preset-hours" type="number" min="0.5" step="0.5" placeholder="e.g. 4"></label>
        <label class="from-wrap">From<input class="preset-from" placeholder="e.g. Estepona"></label>
        <label class="to-wrap">To<input class="preset-to" placeholder="e.g. Ibiza"></label>
      </div>
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
  const content=`<section class="form-card"><div class="actions" style="justify-content:space-between"><div><h2>${edit?'Edit draft':'New invoice'}</h2><p class="sub">Invoice numbers are allocated only when you issue the invoice.</p></div>${edit?`<a class="btn light" href="/invoices/${invoice.id}">Back to invoice</a>`:''}</div><form method="post" action="${action}" id="invoiceForm"><div class="form-grid three"><label>Customer<select name="customer_id" required><option value="">Choose customer</option>${customers.map(c=>`<option value="${c.id}" ${invoice?.customer_id===c.id?'selected':''}>${esc(c.company_name||c.contact_name)}</option>`).join('')}</select></label><label>Invoice language<select name="invoice_language"><option value="bilingual" ${invoice?.invoice_language==='bilingual'||!invoice?'selected':''}>Bilingual</option><option value="en" ${invoice?.invoice_language==='en'?'selected':''}>English</option><option value="es" ${invoice?.invoice_language==='es'?'selected':''}>Spanish</option></select></label><label>Booking reference<input name="booking_reference" value="${esc(invoice?.booking_reference||'')}"></label><label>Service / course title<input name="service_title" value="${esc(invoice?.service_title||'')}" placeholder="e.g. Private Sailing Tuition" required></label><label>Start date<input id="serviceStart" type="date" name="service_start_date" value="${iso(invoice?.service_start_date)}"></label><label>End date<input type="date" name="service_end_date" value="${iso(invoice?.service_end_date)}"></label><label>Issue date<input type="date" name="issue_date" value="${issueDate}"></label><label>Due date<input type="date" name="due_date" value="${dueDate}"></label><label>Payment due now<select id="paymentMode" name="payment_mode"><option value="auto" ${invoice?.payment_mode==='auto'||!invoice?'selected':''}>Auto from booking date</option><option value="full" ${invoice?.payment_mode==='full'?'selected':''}>Full balance</option><option value="deposit" ${invoice?.payment_mode==='deposit'?'selected':''}>25% deposit</option><option value="custom" ${invoice?.payment_mode==='custom'?'selected':''}>Custom amount</option></select></label><label id="customDueWrap" class="${invoice?.payment_mode==='custom'?'':'hide'}">Custom amount due €<input id="customDue" type="number" step="0.01" min="0" name="custom_amount_due" value="${invoice?.payment_mode==='custom'&&invoice.amount_due_now_minor!=null?major(invoice.amount_due_now_minor).toFixed(2):''}"></label><label>Customer reference<input name="customer_reference" value="${esc(invoice?.customer_reference||'')}"></label><label>Bank transfer<select name="bank_transfer_enabled"><option value="1" ${invoice?.bank_transfer_enabled!==false?'selected':''}>Enabled</option><option value="0" ${invoice?.bank_transfer_enabled===false?'selected':''}>Disabled</option></select></label></div><div class="card" style="margin-top:16px;background:#fbfcfc"><h2>Invoice lines</h2><div id="lineRows">${lineRowsHtml(items)}</div><div class="actions" style="margin-top:10px"><button class="btn light" type="button" id="addLine">+ Add line</button></div><div class="totals"><div class="totals-row"><span>Net</span><strong id="calcNet">€0.00</strong></div><div class="totals-row"><span>VAT</span><strong id="calcVat">€0.00</strong></div><div class="totals-row total"><span>Total</span><strong id="calcTotal">€0.00</strong></div><div class="totals-row"><span>Due now</span><strong id="calcDue">€0.00</strong></div></div></div><div class="form-grid"><label class="full">Customer notes<textarea name="customer_notes">${esc(invoice?.customer_notes||'')}</textarea></label><label class="full">Internal notes<textarea name="internal_notes">${esc(invoice?.internal_notes||'')}</textarea></label></div><div class="notice" id="depositNotice" style="margin-top:12px">The automatic rule uses Sotoboats' current terms: 25% deposit when the start date is more than 30 days away; otherwise full payment is due.</div><div class="actions" style="margin-top:14px"><button class="btn gold">${edit?'Save draft changes':'Save draft'}</button></div></form></section><script>
  const depPct=${Number(tenant.deposit_percent)}; const threshold=${Number(tenant.deposit_threshold_days)};
  const descriptionPresets={
    tuition:{
      type:'hours',
      en:h=>`Private sailing tuition (departing from Estepona, life jackets provided. Up to ${h||'X'} hour${Number(h)===1?'':'s'} of sailing)`,
      es:h=>`Clases particulares de vela (salida desde Estepona, chalecos salvavidas incluidos. Hasta ${h||'X'} hora${Number(h)===1?'':'s'} de navegación)`
    },
    sunseeker:{
      type:'hours',
      en:h=>`${h||'X'} hour${Number(h)===1?'':'s'} charter – Sunseeker (including Captain, host, snacks, cava, white wine, beer and soft drinks)`,
      es:h=>`Chárter de ${h||'X'} hora${Number(h)===1?'':'s'} – Sunseeker (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)`
    },
    catamaran:{
      type:'hours',
      en:h=>`${h||'X'} hour${Number(h)===1?'':'s'} charter – Catamaran (including Captain, host, snacks, cava, white wine, beer and soft drinks)`,
      es:h=>`Chárter de ${h||'X'} hora${Number(h)===1?'':'s'} – Catamarán (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)`
    },
    jeanneau:{
      type:'hours',
      en:h=>`${h||'X'} hour${Number(h)===1?'':'s'} charter – Jeanneau sail boat (including Captain, host, snacks, cava, white wine, beer and soft drinks)`,
      es:h=>`Chárter de ${h||'X'} hora${Number(h)===1?'':'s'} – Velero Jeanneau (incluye patrón, atención a bordo, aperitivos, cava, vino blanco, cerveza y refrescos)`
    },
    morocco_tuition:{
      type:'fixed',
      en:()=>`Morocco sailing trip – Sailing tuition`,
      es:()=>`Viaje a vela a Marruecos – Clases de vela`
    },
    morocco_subsistence:{
      type:'fixed',
      en:()=>`Morocco sailing trip – Subsistence, cleaning, use of onboard facilities`,
      es:()=>`Viaje a vela a Marruecos – Manutención, limpieza y uso de las instalaciones a bordo`
    },
    subsistence:{
      type:'fixed',
      en:()=>`Subsistence, cleaning, use of onboard facilities`,
      es:()=>`Manutención, limpieza y uso de las instalaciones a bordo`
    },
    delivery:{
      type:'route',
      en:(a,b)=>`Boat delivery from ${a||'X'} to ${b||'X'} (excluding fuel, insurance)`,
      es:(a,b)=>`Traslado de embarcación de ${a||'X'} a ${b||'X'} (combustible y seguro no incluidos)`
    }
  };

  function updatePreset(row){
    const key=row.querySelector('.description-preset')?.value||'';
    const wrap=row.querySelector('.preset-wrap');
    wrap.classList.remove('show-hours','show-route');
    if(!key || key==='custom') return;
    const p=descriptionPresets[key];
    if(!p) return;
    if(p.type==='hours') wrap.classList.add('show-hours');
    if(p.type==='route') wrap.classList.add('show-route');
    const h=row.querySelector('.preset-hours')?.value||'';
    const a=row.querySelector('.preset-from')?.value||'';
    const b=row.querySelector('.preset-to')?.value||'';
    row.querySelector('.desc-en').value=p.type==='route'?p.en(a,b):p.en(h);
    row.querySelector('.desc-es').value=p.type==='route'?p.es(a,b):p.es(h);
  }

  function wireLineRow(row){
    row.querySelector('.remove')?.addEventListener('click',()=>{
      if(document.querySelectorAll('.line-row').length>1) row.remove();
      else {
        row.querySelectorAll('input[type=text], input:not([type])').forEach(x=>x.value='');
        row.querySelector('.desc-en').value='';
        row.querySelector('.desc-es').value='';
      }
      calcInvoice();
    });
    row.querySelector('.description-preset')?.addEventListener('change',()=>updatePreset(row));
    row.querySelector('.preset-hours')?.addEventListener('input',()=>updatePreset(row));
    row.querySelector('.preset-from')?.addEventListener('input',()=>updatePreset(row));
    row.querySelector('.preset-to')?.addEventListener('input',()=>updatePreset(row));
    row.querySelectorAll('input,select').forEach(x=>x.addEventListener('input',calcInvoice));
  }

  function addLine(){
    const wrap=document.getElementById('lineRows');
    const d=document.createElement('div');
    d.className='line-grid line-row';
    d.innerHTML=`<div style="grid-column:1/-1">
      <div class="preset-wrap">
        <label>Description template<select class="description-preset">
          <option value="">Choose a description…</option>
          <option value="tuition">Private sailing tuition</option>
          <option value="sunseeker">Charter – Sunseeker</option>
          <option value="catamaran">Charter – Catamaran</option>
          <option value="jeanneau">Charter – Jeanneau sail boat</option>
          <option value="morocco_tuition">Morocco sailing trip – Sailing tuition</option>
          <option value="morocco_subsistence">Morocco sailing trip – Subsistence / cleaning / onboard facilities</option>
          <option value="subsistence">Subsistence / cleaning / onboard facilities</option>
          <option value="delivery">Boat delivery</option>
          <option value="custom">Other / Custom description</option>
        </select></label>
        <label class="hours-wrap">Hours<input class="preset-hours" type="number" min="0.5" step="0.5" placeholder="e.g. 4"></label>
        <label class="from-wrap">From<input class="preset-from" placeholder="e.g. Estepona"></label>
        <label class="to-wrap">To<input class="preset-to" placeholder="e.g. Ibiza"></label>
      </div>
    </div>
    <div><label>English description<input class="desc-en" name="description_en" required></label><label style="margin-top:6px">English detail<input name="detail_en"></label></div>
    <div><label>Spanish description<input class="desc-es" name="description_es"></label><label style="margin-top:6px">Spanish detail<input name="detail_es"></label></div>
    <label>Qty<input type="number" min="0.001" step="0.001" name="quantity" value="1" required></label>
    <label>Net unit €<input type="number" min="0" step="0.01" name="unit_price" value="0.00" required></label>
    <label>VAT<select name="tax_rate"><option value="0">0%</option><option value="10">10%</option><option value="21" selected>21%</option></select></label>
    <button class="remove" type="button">×</button>`;
    wrap.appendChild(d);
    wireLineRow(d);
    calcInvoice();
  }

  function calcInvoice(){
    let net=0,vat=0;
    document.querySelectorAll('.line-row').forEach(r=>{
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
  return `<div class="invoice-sheet" id="invoiceSheet"><div class="invoice-head"><div class="invoice-brand"><h2>SOTOBOATS</h2><p><strong>${esc(tenant.legal_name)}</strong></p><p>${esc(tenant.address_1||'')} · ${esc(tenant.postcode||'')} ${esc(tenant.city||'')}</p><p>${esc(tenant.region||'')} · ${esc(tenant.country_name||'')}</p><p>${esc(tenant.email||'')} · ${esc(tenant.phone||'')}</p><p>Company ID: ${esc(tenant.tax_id||'')}</p></div><div class="invoice-meta"><strong>Invoice / Factura ${esc(i.invoice_number||'DRAFT')}</strong><p>Issue date / Fecha: ${fmtDate(i.issue_date)}</p><p>Due date / Vencimiento: ${fmtDate(i.due_date)}</p>${i.booking_reference?`<p>Booking ref: ${esc(i.booking_reference)}</p>`:''}${identity}</div></div><div class="billto"><div><div class="eyebrow">Bill to / Facturar a</div><p><strong>${esc(i.company_name||i.contact_name)}</strong></p>${i.company_name?`<p>${esc(i.contact_name)}</p>`:''}<p>${esc([i.billing_address_1,i.billing_address_2,i.billing_city,i.billing_region,i.billing_postcode].filter(Boolean).join(', '))}</p></div><div><div class="eyebrow">Customer / Cliente</div><p>${esc(i.email||'')}</p><p>${esc(i.phone||'')}</p>${i.tax_number?`<p>Tax ID: ${esc(i.tax_number)}</p>`:''}</div></div><h3 class="invoice-title">${esc(i.service_title||'Invoice')}${i.service_start_date?` | ${fmtDate(i.service_start_date)}${i.service_end_date?` to ${fmtDate(i.service_end_date)}`:''}`:''}</h3><table class="invoice-table"><thead><tr><th>Product or Service</th><th>Qty</th><th>Net</th><th>VAT</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><div class="invoice-summary"><div class="summary-row"><span>Subtotal</span><strong>${euro(i.subtotal_minor)}</strong></div>${Object.entries(vatGroups).sort((a,b)=>Number(a[0])-Number(b[0])).map(([rate,amt])=>`<div class="summary-row"><span>IVA / VAT ${rate}%</span><strong>${euro(amt)}</strong></div>`).join('')}<div class="summary-row"><span>Tax total</span><strong>${euro(i.tax_minor)}</strong></div><div class="summary-row"><span>Invoice total</span><strong>${euro(i.total_minor)}</strong></div><div class="summary-row"><span>Amount paid</span><strong>${euro(i.paid_minor)}</strong></div><div class="summary-row final"><span>Balance due</span><strong>${euro(i.outstanding_minor)}</strong></div>${i.amount_due_now_minor!=null&&Number(i.amount_due_now_minor)<Number(i.outstanding_minor)?`<div class="summary-row" style="margin-top:7px;background:#f6efe3;border-radius:8px"><span>Amount due now</span><strong>${euro(i.amount_due_now_minor)}</strong></div>`:''}</div>${i.customer_notes?`<div class="lang-block"><strong>Notes</strong><br>${esc(i.customer_notes)}</div>`:''}${showEn?`<div class="lang-block"><strong>English</strong><p>${esc(tenant.english_footer||'')}</p>${i.bank_transfer_enabled?`<p><strong>Bank transfer:</strong> ${esc(tenant.bank_account_name||'')} · IBAN ${esc(tenant.bank_iban||'')} · BIC ${esc(tenant.bank_bic||'')}</p>`:''}</div>`:''}${showEs?`<div class="lang-block"><strong>Español</strong><p>${esc(tenant.spanish_footer||'')}</p>${i.bank_transfer_enabled?`<p><strong>Transferencia bancaria:</strong> ${esc(tenant.bank_account_name||'')} · IBAN ${esc(tenant.bank_iban||'')} · BIC ${esc(tenant.bank_bic||'')}</p>`:''}</div>`:''}</div>`;
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
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(25).text('SOTOBOATS',45,45);
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        `${tenant.legal_name}\n${tenant.address_1 || ''}\n${tenant.postcode || ''} ${tenant.city || ''}, ${tenant.region || ''}\n${tenant.country_name || ''}\n${tenant.email || ''} · ${tenant.phone || ''}\nCompany ID: ${tenant.tax_id || ''}`,
        45,82,{width:250}
      );
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(15).text(`Invoice / Factura ${i.invoice_number}`,330,48,{width:220,align:'right'});
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        `Issue date: ${fmtDate(i.issue_date)}\nDue date: ${fmtDate(i.due_date)}${i.booking_reference?`\nBooking ref: ${i.booking_reference}`:''}`,
        330,72,{width:220,align:'right'}
      );

      doc.moveTo(45,150).lineTo(550,150).strokeColor('#dce3e6').stroke();
      doc.fillColor(gold).font('Helvetica-Bold').fontSize(8).text('BILL TO / FACTURAR A',45,166);
      doc.fillColor(navy).fontSize(10).text(i.company_name||i.contact_name,45,180);
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(
        `${i.company_name?i.contact_name+'\n':''}${[i.billing_address_1,i.billing_address_2,i.billing_city,i.billing_region,i.billing_postcode].filter(Boolean).join(', ')}\n${i.email||''}\n${i.phone||''}`,
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
        ['Balance due',i.outstanding_minor]
      ];
      for(const [label,amt] of summary){
        const final=label==='Balance due';
        if(final) doc.rect(325,y-4,225,24).fill('#eef4f7');
        doc.fillColor(navy).font(final?'Helvetica-Bold':'Helvetica').fontSize(final?11:8).text(label,335,y);
        doc.text(euro(amt),465,y,{width:75,align:'right'});
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
  const data=await loadInvoice(req.params.id); if(!data)return res.status(404).send('Invoice not found.'); const i=data.invoice;
  const emailBtn=i.locked_at&&i.email?`<form method="post" action="/invoices/${i.id}/email" onsubmit="return confirm('${i.emailed_at?'Resend':'Send'} invoice ${esc(i.invoice_number||'')} to ${esc(i.email)}?');"><button class="btn gold">${i.emailed_at?'Resend invoice':'Send invoice'}</button></form>`:'';
  const controls=`<div class="actions no-print" style="margin-bottom:15px">${!i.locked_at?`<a class="btn light" href="/invoices/${i.id}/edit">Edit draft</a><form method="post" action="/invoices/${i.id}/issue" onsubmit="return confirm('Issue this invoice? Once issued, its financial content will be locked.');"><button class="btn gold">Issue invoice</button></form>`:`<a class="btn light" target="_blank" href="/invoices/${i.id}/pdf">Download PDF</a><button class="btn light" onclick="window.print()">Print</button>${emailBtn}`}${i.emailed_at?`<span class="pill green">Emailed ${fmtDate(i.emailed_at)} to ${esc(i.emailed_to||i.email||'')}</span>`:''}<a class="btn light" href="/invoices">Back to invoices</a></div>`;
  const payment=i.locked_at&&Number(i.outstanding_minor)>0?`<section class="card no-print"><h2>Record payment</h2><form method="post" action="/invoices/${i.id}/payments"><div class="form-grid three"><label>Amount €<input type="number" step="0.01" min="0.01" max="${major(i.outstanding_minor).toFixed(2)}" name="amount" value="${major(i.amount_due_now_minor??i.outstanding_minor).toFixed(2)}" required></label><label>Method<select name="method"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card_external">Card - external</option><option value="other">Other</option></select></label><label>Reference<input name="reference"></label></div><div class="actions" style="margin-top:12px"><button class="btn gold">Record payment</button></div></form></section>`:'';
  const audit=data.events.length?`<section class="card no-print"><h2>Audit trail</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Actor</th></tr></thead><tbody>${data.events.map(e=>`<tr><td>${fmtDate(e.created_at)}</td><td>${esc(e.event_type.replaceAll('_',' '))}</td><td>${esc(e.actor_name||'System')}</td></tr>`).join('')}</tbody></table></div></section>`:'';
  res.send(shell(i.invoice_number||'Draft Invoice','invoices',`${controls}${invoicePreview(data)}${payment}${audit}`,i.locked_at?'Issued invoices are locked. Payments can still be recorded.':'This is a draft and can still be edited.'));
});

app.post('/invoices/:id/issue',async(req,res)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const tenant=await getTenant(client);const i=(await client.query(`SELECT * FROM customer_invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[req.params.id,tenant.id])).rows[0];if(!i)throw new Error('Invoice not found.');if(i.locked_at)throw new Error('Invoice has already been issued.');const t=(await client.query(`SELECT * FROM invoice_tenants WHERE id=$1 FOR UPDATE`,[tenant.id])).rows[0];const number=`${t.invoice_prefix||''}${String(t.next_invoice_number).padStart(Number(t.invoice_padding||7),'0')}`;const issue=i.issue_date||new Date().toISOString().slice(0,10);let due=i.due_date;if(!due){const d=new Date(`${issue}T12:00:00`);d.setDate(d.getDate()+Number(t.payment_terms_days||5));due=d.toISOString().slice(0,10);}await client.query(`UPDATE customer_invoices SET invoice_number=$1,issue_date=$2,due_date=$3,status='sent',issued_at=now(),locked_at=now(),updated_at=now() WHERE id=$4`,[number,issue,due,i.id]);await client.query(`UPDATE invoice_tenants SET next_invoice_number=next_invoice_number+1,updated_at=now() WHERE id=$1`,[tenant.id]);await client.query(`INSERT INTO customer_invoice_events(tenant_id,invoice_id,event_type,actor_name,details) VALUES($1,$2,'invoice_issued','Sotoboats Admin',jsonb_build_object('invoice_number',to_jsonb($3::text)))`,[tenant.id,i.id,number]);await client.query('COMMIT');res.redirect(`/invoices/${i.id}`);}catch(err){await client.query('ROLLBACK');res.status(400).send(esc(err.message));}finally{client.release();}
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
      ADD COLUMN IF NOT EXISTS emailed_to TEXT;
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
