# Deseret SACCO

Website, member portal and staff admin for Deseret SACCO Society Ltd.

## Run

Needs Node.js 22.5 or newer (uses the built-in `node:sqlite`).

```
npm install
npm run seed   # reset the database with fictional demo data
npm start      # http://localhost:3000
```

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
