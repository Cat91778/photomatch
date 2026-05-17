# PhotoMatch v5 — Railway Variables

Add these in Railway → your project → Variables:

| Variable             | Value                                         |
|----------------------|-----------------------------------------------|
| DROPBOX_TOKEN        | your sl. token                                |
| ANTHROPIC_KEY        | your sk-ant- key                              |
| GROUP1_PASSWORD      | password for Group 1                          |
| GROUP1_NAME          | Group 1 name e.g. Warehouse                  |
| GROUP2_PASSWORD      | password for Group 2                          |
| GROUP2_NAME          | Group 2 name e.g. Sales                      |
| ADMIN_PASSWORD       | password to clear shipment log               |
| GOOGLE_SHEET_ID      | your Google Sheet ID                          |
| GOOGLE_SERVICE_ACCT  | entire contents of your JSON key file        |
| MAIN_FOLDER          | /_Cathy's Order                               |
| NEW_ARRIVALS_FOLDER  | /_Cathy's Order/New Arrivals                  |
| INDEX_DROPBOX_PATH   | /_Cathy's Order/photo-index.json              |

---

## SKU Format
  16  +  B  +  84  +  G
  │      │     │      │
  │      │     │      └─ Color code
  │      │     └─ Next available number (from Google Sheet)
  │      └─ Category code
  └─ Vendor code

New photo saved as: 16B84G.jpg
Saved to: /_Cathy's Order/New Arrivals/16B84G.jpg
