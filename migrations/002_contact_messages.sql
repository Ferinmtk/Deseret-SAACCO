-- Messages sent from the public Contact page, answered by staff in Admin › Messages.
CREATE TABLE contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','answered')),
  handled_by INTEGER REFERENCES staff(id),
  handled_at TIMESTAMP(0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);
