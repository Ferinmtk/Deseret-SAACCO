# Deseret SACCO

Website, member portal and staff admin for Deseret SACCO Society Ltd.

Live: https://deseret-sacco.vercel.app

## Stack

Node.js + Express + EJS, PostgreSQL on Neon, hosted on Vercel. Logins are stored in the database.

## Run locally

Needs Node.js 22+ and the Vercel CLI, signed in to the project. The database is online (Neon), so nothing is stored on your computer.

```
npm install
vercel link                      # once: connect this folder to the deseret-sacco project
vercel env pull .env.local       # database and session settings
npm run migrate                  # apply any new database changes
npm run seed                     # reset the database with fictional demo data
npm start                        # http://localhost:3000
```

`npm run seed` wipes the shared demo database. Don't run it once real data is in.

## Database changes

Add a new numbered file to `migrations/` (e.g. `002_add_sms_log.sql`) and run `npm run migrate`. Applied files are recorded in `schema_migrations`, so each one runs only once.

## Demo logins (password `demo1234`)

- Member portal, `/portal/login`: `DS0001`
- Admin, `/admin/login`:
  - `clerk@deseret.demo`: registers members, records payments, verifies members' M-Pesa codes
  - `credit@deseret.demo`: appraises loans
  - `manager@deseret.demo`: approves members, payments and loans (records the credit committee decision); edits rules
  - `treasurer@deseret.demo`: verifies payments, disburses loans
  - `board@deseret.demo`: read-only

No one can approve their own entry, and a loan's recommender, approver and disburser must be different people.

## Rules

Loan and membership rules follow the registered by-laws (2006, as amended). Each setting in **Admin › Products & rules** shows the by-law it comes from. Interest rates, deposit interest and dividends aren't in the by-laws. They are placeholders until the SACCO confirms them.
