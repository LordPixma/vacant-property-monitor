# Data protection

This is a starting point for the charity's own assessment, not legal advice. Before going live, the charity should record a lawful basis (legitimate interests is the likely one, with a legitimate interests assessment), update its privacy notice, and consider a DPIA, because the tool combines location data, photographs and observations about places where vulnerable people may be.

## What the system holds

| Data | Personal data? | Notes |
|---|---|---|
| Property addresses, status, condition | Usually no — but a private owner-occupied home's status can relate to an identifiable owner | Keep notes factual and about the building. |
| Owner notes | **Yes** when the owner is an individual | Visible to coordinators and admins only; redacted in the audit log. Record only what is needed to bring the home back into use. |
| Visit notes | Can be | Never record names, descriptions or anything that identifies a person seen at a property. "Signs of rough sleeping" is recorded as a tick, not a description. |
| Photos | Can be | Photograph the building from the street. No people, no number plates, no views into windows. The phone strips EXIF (including camera GPS) before upload. |
| Staff accounts | Yes | Name, email, optional phone, sign-in times. |
| GPS on visits | Yes (about the worker) | Optional per visit; workers can untick it. |
| Audit log | Yes (about staff) | Who changed what and when. |

## Controls in the software

- Role-based access; viewers cannot write; owner notes are coordinator-only.
- Every write audited; admins can review the log.
- Photos private in R2, served only to signed-in users; no public listing.
- Export is coordinator-only and audited.
- Search engines are told not to index (`noindex`).

## Retention (suggested)

Decide and record these; the app does not yet delete automatically.

- Closed cases (occupied, brought back into use, demolished): archive after 12 months, delete photos after 24.
- Visit notes on closed cases: 24 months.
- Audit log: 24 months.
- Accounts of people who leave: disable on the day, delete after 12 months.

## Subprocessors to disclose

Cloudflare (hosting, database, storage). The public-data services receive only postcodes and coordinates, never personal data.

## Safety and the law

- Workers observe from the public highway. Entering a building or land without permission can be trespass, and squatting in a residential building is a criminal offence in England and Wales (LASPO 2012, s.144). The tool exists to get empty homes back into lawful use through councils and owners, and to get help to people sleeping rough. It must not be used to direct anyone to occupy an empty building.
- Someone who may be sleeping rough is referred to StreetLink (thestreetlink.org.uk) or the local outreach team. In an emergency, 999.
