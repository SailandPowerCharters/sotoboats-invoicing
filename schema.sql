BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS invoice_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  trading_name text NOT NULL,
  legal_name text NOT NULL,
  tax_id text,
  country_code char(2) NOT NULL DEFAULT 'ES',
  currency_code char(3) NOT NULL DEFAULT 'EUR',
  address_1 text,
  address_2 text,
  postcode text,
  city text,
  region text,
  country_name text,
  email text,
  phone text,
  website text,
  invoice_prefix text NOT NULL DEFAULT '',
  invoice_padding integer NOT NULL DEFAULT 7,
  next_invoice_number integer NOT NULL DEFAULT 1575,
  payment_terms_days integer NOT NULL DEFAULT 5,
  default_language text NOT NULL DEFAULT 'bilingual' CHECK (default_language IN ('en','es','bilingual')),
  deposit_percent numeric(7,4) NOT NULL DEFAULT 25.0000,
  deposit_threshold_days integer NOT NULL DEFAULT 30,
  platform_fee_percent numeric(7,4) NOT NULL DEFAULT 0.0000,
  bank_account_name text,
  bank_name text,
  bank_iban text,
  bank_bic text,
  english_footer text,
  spanish_footer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES invoice_tenants(id) ON DELETE CASCADE,
  customer_type text NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('business','individual')),
  company_name text,
  contact_name text NOT NULL,
  email text,
  phone text,
  billing_address_1 text,
  billing_address_2 text,
  billing_city text,
  billing_region text,
  billing_postcode text,
  billing_country_code char(2),
  tax_number text,
  identity_type text,
  identity_number text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_customers_tenant ON invoice_customers(tenant_id);

CREATE TABLE IF NOT EXISTS customer_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES invoice_tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES invoice_customers(id),
  invoice_number text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','part_paid','paid','overdue','cancelled','credited')),
  invoice_language text NOT NULL DEFAULT 'bilingual' CHECK (invoice_language IN ('en','es','bilingual')),
  issue_date date,
  due_date date,
  service_title text,
  service_start_date date,
  service_end_date date,
  booking_reference text,
  customer_reference text,
  customer_notes text,
  internal_notes text,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  paid_minor bigint NOT NULL DEFAULT 0,
  outstanding_minor bigint NOT NULL DEFAULT 0,
  amount_due_now_minor bigint,
  payment_mode text NOT NULL DEFAULT 'auto' CHECK (payment_mode IN ('auto','full','deposit','custom')),
  bank_transfer_enabled boolean NOT NULL DEFAULT true,
  online_payments_enabled boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  locked_at timestamptz,
  original_invoice_id uuid REFERENCES customer_invoices(id),
  correction_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issued_customer_invoice_has_number CHECK (issued_at IS NULL OR invoice_number IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_invoice_number_unique
  ON customer_invoices(tenant_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_invoices_tenant_status ON customer_invoices(tenant_id, status);

CREATE TABLE IF NOT EXISTS customer_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  description_en text NOT NULL,
  description_es text,
  detail_en text,
  detail_es text,
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_minor bigint NOT NULL DEFAULT 0,
  tax_rate numeric(7,4) NOT NULL DEFAULT 21.0000,
  line_net_minor bigint NOT NULL DEFAULT 0,
  line_tax_minor bigint NOT NULL DEFAULT 0,
  line_total_minor bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customer_invoice_items_invoice ON customer_invoice_items(invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS customer_invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES invoice_tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES customer_invoices(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL DEFAULT 'EUR',
  method text NOT NULL CHECK (method IN ('bank_transfer','cash','card_external','stripe','other')),
  reference text,
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending','succeeded','failed','refunded','part_refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_invoice_payments_invoice ON customer_invoice_payments(invoice_id);

CREATE TABLE IF NOT EXISTS customer_invoice_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES invoice_tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_name text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_invoice_events_invoice ON customer_invoice_events(invoice_id, created_at);

INSERT INTO invoice_tenants (
  code, trading_name, legal_name, tax_id, country_code, currency_code,
  address_1, postcode, city, region, country_name, email, phone,
  invoice_prefix, invoice_padding, next_invoice_number, payment_terms_days,
  default_language, deposit_percent, deposit_threshold_days,
  bank_account_name, bank_name, bank_iban, bank_bic,
  english_footer, spanish_footer
)
VALUES (
  'SOTOBOATS', 'Sotoboats', 'Marbella Sailing School S.L.', 'ESB93733012', 'ES', 'EUR',
  'Edificio Levante 24b', '29680', 'Estepona', 'Andalucía', 'Spain', 'info@sailandpower.es', '+34 621 089 785',
  '', 7, 1575, 5, 'bilingual', 25.0000, 30,
  'Marbella Sailing School S.L.', 'CaixaBank', 'ES0621006848150200185240', 'CAIXESBBXXX',
  'Thank you for choosing Sotoboats, trading as Marbella Sailing School S.L. Payment is due within 5 days of receipt. Bookings made within 30 days of the service start date require full payment. Bookings made more than 30 days in advance require a 25% deposit, with the balance due 30 days before arrival.',
  'Gracias por elegir Sotoboats, nombre comercial de Marbella Sailing School S.L. El pago vence dentro de los 5 días posteriores a la recepción. Las reservas realizadas dentro de los 30 días anteriores a la fecha de inicio requieren el pago total. Para reservas realizadas con más de 30 días de antelación, se requiere un depósito del 25%, con el saldo pendiente 30 días antes de la llegada.'
)
ON CONFLICT (code) DO UPDATE SET
  trading_name = EXCLUDED.trading_name,
  legal_name = EXCLUDED.legal_name,
  tax_id = EXCLUDED.tax_id,
  updated_at = now();

COMMIT;
