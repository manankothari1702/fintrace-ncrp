# FinTrace NCRP — User Guide

**Cyber Crime Financial Trail Analyzer**
For Investigating Officers, Cyber Crime Cells (India)

Version 0.1.0 (Beta) · Developed by M Intergraph Systems Pvt. Ltd. (MINT)

---

FinTrace NCRP turns the Excel "money trail" file you download from the National
Cyber Crime Reporting Portal into a ready-to-use investigation pack: it traces
the money layer by layer, flags the mule accounts, calculates how much can still
be frozen (lien), drafts the bank letters for you, and produces a printable PDF
dossier for the case file.

It runs **completely offline** on your own computer. It needs **no internet, no
login, and no separate database**. Nothing you upload ever leaves your machine.

This guide is written for officers, not engineers. If anything is unclear,
contact MINT support — details are in [Section J](#j-contact--mint-support).

---

## Contents

- [A. Installing FinTrace NCRP](#a-installing-fintrace-ncrp)
- [B. Getting the NCRP file from cybercrime.gov.in](#b-getting-the-ncrp-file-from-cybercrimegovin)
- [C. Uploading and analysing a file](#c-uploading-and-analysing-a-file)
- [D. Understanding the Dashboard](#d-understanding-the-dashboard)
- [E. How to read the Mule Score](#e-how-to-read-the-mule-score)
- [F. Using the Lien Tracker](#f-using-the-lien-tracker)
- [G. Sending the Draft Emails](#g-sending-the-draft-emails)
- [H. Generating and printing the PDF report](#h-generating-and-printing-the-pdf-report)
- [I. Frequently Asked Questions](#i-frequently-asked-questions)
- [J. Contact — MINT support](#j-contact--mint-support)

---

## A. Installing FinTrace NCRP

Installation is three steps.

1. **Download.** Copy the installer file — **`FinTrace NCRP Setup 0.1.0.exe`** —
   onto the computer you will use for investigations. You can receive it on a
   pen-drive or from your unit's software share. No internet connection is
   required at any point.

2. **Install.** Double-click the installer. Windows may show a security prompt
   the first time — choose **More info → Run anyway** (the app is from MINT).
   The wizard lets you keep the default location or pick your own, and creates a
   **Desktop shortcut** and a **Start Menu** entry. Click **Finish** when done.

3. **Open.** Double-click the **FinTrace NCRP** icon on your Desktop. A short
   start-up screen appears for a few seconds while the analysis engine wakes up,
   then the main window opens. That's it — you are ready to work.

> **System needs:** Windows 10 or Windows 11, 4 GB RAM or more. No admin rights
> are needed to run it after installation.

---

## B. Getting the NCRP file from cybercrime.gov.in

FinTrace reads the **BankAction CompleteTrail** Excel file that the NCRP portal
produces for a complaint. To get it:

1. Open a web browser and log in to the **National Cyber Crime Reporting Portal**
   at **https://cybercrime.gov.in** using your Law-Enforcement Agency (LEA) login.
2. Open the complaint / acknowledgement you are investigating (search by the
   **Acknowledgement Number** if needed).
3. Go to the **Bank Action / Money Trail** section of that complaint.
4. Use the **Download / Export** option to save the **Complete Trail** report.
   It downloads as an Excel file (`.xlsx`).
5. Note where your browser saved it (usually the **Downloads** folder).

That downloaded `.xlsx` file is exactly what FinTrace expects. You do **not** need
to open it, clean it, or change it in Excel first — upload it as-is.

> The portal's menu labels change from time to time. If you cannot find the
> export, ask your nodal officer or follow the portal's current help pages — look
> for anything named *"Complete Trail"*, *"Bank Action"*, or *"Money Trail"*.

**A real CompleteTrail file has several sheets** — one for each way money left an
account (bank transfers, ATM withdrawals, POS purchases, AEPS, funds put on hold,
and so on). FinTrace reads **all** of these sheets automatically and stitches
them into one trail. You don't have to do anything special.

---

## C. Uploading and analysing a file

1. Open FinTrace and you will land on the **Upload** screen.
2. **Drag the Excel file** onto the large dashed box — or click the box and
   **browse** to it. Accepted types are `.xlsx` and `.xls`, up to **50 MB**.
3. The file name and size appear. Click **Upload & Analyze**.
4. You will see a progress bar:
   - **Uploading…** — the file is being read in (fast).
   - **Analysing the trail…** — FinTrace is tracing the money. This usually
     takes a few seconds; a very large file (tens of thousands of rows) may take
     up to about half a minute.
5. When it finishes you see a green **"Analysis complete"** panel with the
   headline numbers (transactions, disputed amount, layers). Click
   **Open Dashboard →** to begin.

### What the yellow "Parser notes" box means

After a successful upload you may see a yellow box titled **Parser notes**. These
are *information*, not errors. Common notes and what they mean:

| You may see… | What it means |
|---|---|
| "Combined N rows from M sheets" | FinTrace merged the bank-transfer, ATM, POS, AEPS, etc. sheets into one trail. This is normal and good. |
| "Skipped N sheet(s) without recognizable NCRP columns" | A sheet (often a summary or cover sheet) had no transaction data, so it was ignored. Normal. |
| "N duplicate row(s) detected…" | The same transaction appears in more than one channel sheet of the NCRP export. **This is normal NCRP portal behaviour and does not mean your file is bad.** |
| "Skipped N row(s) with no account identifiers" | Blank or total rows in the sheet were ignored. Normal. |

If a file genuinely cannot be read (for example it isn't an NCRP export at all),
FinTrace tells you clearly and does not create a half-finished report.

### Previous Reports

Every file you analyse is remembered under **Previous Reports** at the bottom of
the Upload screen. From there you can re-open a case's **Dashboard**, download its
**PDF**, or **Delete** it. Deleting a report removes all of its data from your
computer and cannot be undone.

---

## D. Understanding the Dashboard

The Dashboard is the case overview. It has four parts.

### 1. The four headline cards

| Card | What it tells you |
|---|---|
| **Total Disputed** | The total fraud amount across the complaint, with the number of transactions analysed. This is the money the victim(s) lost. |
| **Layers in Trail** | How many "hops" the money made. Layer 1 is the first account the victim's money reached; each further layer is one step deeper into the laundering chain. |
| **Mule Accounts** | How many beneficiary accounts FinTrace flagged and scored as likely money-mule accounts. |
| **Lien Eligible** | How much money is still believed to be sitting in accounts (not yet withdrawn as cash) and can therefore still be **frozen by lien**. This is your recovery opportunity. |

### 2. The two charts

- **Amount by Layer** — a bar for each layer, coloured blue (near the victim)
  through to red (the cash-out end). Tall red bars mean a lot of money reached
  the layers closest to withdrawal.
- **Payment Mode Distribution** — how the money moved (UPI, IMPS, NEFT, ATM, …).

### 3. Key Findings & Recommended Actions

A short, plain-language action list written automatically from the analysis — for
example *"₹4.2L already cashed out in Delhi within 6 hours — immediate action
needed."* Read this first; it points you at what matters.

### 4. Top Cashout Locations

A table of the ATMs / outlets where money was physically withdrawn, highest value
first, with location and number of withdrawals. If no cash-out was detected, the
table says so — the money may still be in the accounts (check the Lien Tracker).

> Wherever the source file left a field blank (real NCRP files often have no
> beneficiary *name*, city, or state), FinTrace shows a dash **"—"** rather than
> a blank or a made-up value.

---

## E. How to read the Mule Score

Open **Mule Accounts** from the left menu. Every beneficiary account is given a
**score from 0 to 100** and a colour-coded risk band:

| Score | Risk band | Colour |
|---|---|---|
| 70–100 | **HIGH** | Red |
| 40–69 | **MEDIUM** | Orange |
| 0–39 | **LOW** | Green |

The higher the score, the more the account behaves like a money mule. The score
is built from **six signals**, each worth a fixed number of points:

| Signal | Points | In plain language |
|---|---:|---|
| **Pass-through** | 30 | Money came in and went straight back out again. An account that forwards almost everything it receives behaves like a pipe, not a real customer. |
| **Cash-out speed** | 20 | The money left within a few hours of arriving. Full points if it left within ~4 hours, fading to zero by 24 hours. |
| **Transaction count** | 15 | A lot of transactions ran through the account in this case. |
| **Cross-case** | 20 | The same account turns up in more than one complaint — in this file, or in earlier files you analysed on this computer. A repeat offender. |
| **Geographic spread** | 10 | The cash was withdrawn in a different state from the account's home/bank state — a classic mule pattern. |
| **KYC variance** | 5 | The name, bank, or IFSC recorded for the account is inconsistent across rows. |

The points add up to the final score (capped at 100). The score bar in the table
fills and colours to match.

**How to use it:** sort by score (click the column header) and work the **HIGH**
(red) accounts first — they are your priority targets for a lien and for KYC
requests to the bank. Click any row to expand it and see that account's own
transaction history. Use the filters at the top to narrow by risk level, layer,
or bank.

> The score is an **investigative aid**, not a verdict. It tells you where to
> look first; the evidence in the transactions and the bank's KYC response is
> what stands up in court.

---

## F. Using the Lien Tracker

Open **Lien Tracker** from the left menu. This is your recovery worksheet — the
list of accounts that may still be holding fraud money you can freeze.

### What you see

- At the top: the **total lien-eligible amount**, plus cards for how much has been
  **Applied**, how much came back as **Success**, and the **Recovery Rate**.
- A table with one row per account: account number, bank, IFSC, layer, the amount
  **Received**, the amount already **Forwarded** (withdrawn as cash), the
  **Lien Eligible** amount (what you can still freeze), a **Status**, the date you
  marked it applied, and remarks.

**Lien Eligible** is the disputed money that came into an account **minus** the
disputed money that was already pulled out as cash. In short: *what is probably
still recoverable at that bank.* (The bank confirms the true available balance
when it responds.)

### The officer workflow

1. **Review** the accounts, highest Lien Eligible amount first.
2. Send the lien request to each bank (FinTrace drafts these for you — see
   [Section G](#g-sending-the-draft-emails)).
3. As you act, **update the Status** using the drop-down in each row. It saves
   automatically:
   - **pending** — not yet acted on (the starting state).
   - **applied** — you have sent the lien request to the bank. (FinTrace stamps
     the date.)
   - **success** — the bank confirmed the funds were frozen / lien placed.
   - **rejected** — the bank declined or the money was already gone.
4. To act on many accounts at once, tick the check-boxes on the left and click
   **Mark All as Applied**.
5. Click **Download Lien Template** to save the worksheet as a CSV for your own
   records or to attach to a file note.

If an account list is **empty**, FinTrace tells you why — for example, every
disputed rupee in the trail was already withdrawn as cash, so there is no balance
left to freeze.

---

## G. Sending the Draft Emails

Open **Draft Emails** from the left menu. FinTrace writes **one formal
lien-request letter per bank**, grouping all of that bank's flagged accounts into
a single letter. Each letter already cites **Section 102 of the Cr.P.C., read
with the Information Technology Act, 2000**, and asks the bank to (1) place a lien
/ freeze the disputed amount, (2) share KYC and the statement of account, and
(3) confirm within 24 hours.

**FinTrace never sends email itself** — by design, so that nothing leaves your
computer automatically. You copy each letter into your own official email and
send it. To do that:

1. Click a bank to open its letter. Check the **Subject**, the account table, and
   the body.
2. Click **📋 Copy to Clipboard**.
3. Open your official email client, paste the letter into a new message, and
   **address it to that bank's Nodal Officer** for cyber-fraud / LEA requests
   (see below).
4. Sign it under your designation, attach anything required, and send.
5. Back in FinTrace, click **Mark as Sent** so the letter shows as done.

You can also click **⬇ Download All as Word Document** to save every letter in one
`.doc` file for printing or for the case file.

### Addressing the letter — bank nodal-officer email format

Each letter shows a **placeholder** "To" address such as
`nodal.officer@<bank>.example`. **You must replace this with the bank's real
Nodal Officer email** before sending. Use the official channel:

- Most banks publish a dedicated **Nodal Officer for Law-Enforcement / Cyber-fraud
  requests**. The address commonly follows the form
  `nodalofficer@<bankdomain>` or `cybercell@<bankdomain>` (for example a generic
  shape like `nodal.officer.cyber@examplebank.co.in`).
- The authoritative, up-to-date list of bank nodal-officer contacts is maintained
  for law-enforcement use by **I4C / the NCRP portal** and via **RBI**. Always
  take the current address from that official directory rather than guessing.

> Before dispatch, have the letter approved/signed by the competent authority as
> per your unit's procedure. The letters are **drafts** to save you typing — the
> responsibility for the final, signed communication is yours.

---

## H. Generating and printing the PDF report

FinTrace produces a complete **investigation dossier** as a PDF — suitable for the
case file, for senior officers, and for court.

### To generate it

- From the **Upload** screen, find the case under **Previous Reports** and click
  the **⬇ PDF** button, **or**
- Open the case and use the PDF download.

The PDF opens / downloads in a few seconds. It is also saved on your computer
under your user data folder (see the FAQ for the exact location).

### What's inside

The dossier runs to several pages, each section on its own page:

1. **Cover** — case number, date, headline figures, and a sign-off block for the
   Case Officer.
2. **Executive Summary** — the key figures at a glance.
3. **Layer-by-Layer Analysis**.
4. **Top Mule Accounts** (account numbers are partly masked for safety).
5. **Lien-Eligible Amounts** — the recovery worksheet.
6. **Cashout Analysis** — ATM hot-spots, same-day cash-outs, state spread.
7. **Timeline** — money movement day by day.
8. **Key Findings & Recommended Actions**.
9. **Draft Lien-Request Emails** — every bank letter, ready to copy.

Every page is footed with *"Generated by FinTrace NCRP | MINT"* and a page number.

### Printing the Lien Tracker and Emails screens

The **Lien Tracker** and **Draft Emails** screens are also designed to print
cleanly straight from the app (press **Ctrl + P**). When you print, FinTrace
automatically hides the menu and buttons, flattens the page for paper, and — on
the Emails screen — prints **every** letter (each starting on its own page), even
the ones that are collapsed on screen.

---

## I. Frequently Asked Questions

**1. Does FinTrace send any data over the internet?**
No. It runs entirely on your computer. There are no outbound connections, no
cloud, and no login. Your case data stays on your machine.

**2. Where is my data stored on the computer?**
Under your Windows user profile, in the folder
`%APPDATA%\FinTrace NCRP\` — this contains the database (`fintrace.db`), the
uploaded files (`uploads\`), and the generated PDFs (`exports\`). You can paste
`%APPDATA%\FinTrace NCRP` into the File Explorer address bar to open it.

**3. The biggest file I have is huge. Will it work?**
Yes. FinTrace is built to handle files with tens of thousands of rows without
freezing — the transaction list loads a page at a time and the screen stays
responsive. Analysis of a very large file may take up to about 30 seconds.

**4. The "Parser notes" box mentions duplicates. Did I upload a bad file?**
No. NCRP exports often list the same transaction on more than one sheet, so
FinTrace counts those duplicates and tells you. It is normal and does not affect
the analysis.

**5. Why are some names, cities, or states shown as "—"?**
Real NCRP files frequently leave those fields blank. FinTrace shows a dash so you
can see the field was empty in the source — it never invents data.

**6. The Lien Tracker is empty for my case. Is that a bug?**
No. It means there is no balance left to freeze — typically because the disputed
money in the trail was already withdrawn as cash. The screen explains this.

**7. Can I work on more than one case?**
Yes. Each uploaded file is a separate report, listed under **Previous Reports**.
Open any of them from there. You can keep many cases on the same computer.

**8. Is the Mule Score enough to act against an account?**
Treat it as a **priority guide**, not proof. It tells you which accounts to
investigate and lien first. The transaction evidence and the bank's KYC response
are what you rely on formally.

**9. Does FinTrace email the banks for me?**
No — on purpose. It **drafts** the letters; you copy each one into your own
official email, address it to the bank's nodal officer, get it approved, and send
it. Then mark it **Sent** in the app.

**10. How do I update the disputed amount or fix a wrong row?**
FinTrace analyses the file exactly as the NCRP portal produced it; it does not
edit the source data. If the source file is wrong, correct it at the portal and
re-export, then upload the corrected file as a new report.

---

## J. Contact — MINT support

For installation help, questions, or to report a problem:

**M Intergraph Systems Pvt. Ltd. (MINT)**
FinTrace NCRP Support

- **Email:** support@mintergraph.com
- **Software:** FinTrace NCRP, Version 0.1.0 (Beta)

When you contact support, please include:

- the **version** shown at the bottom of the left menu (v0.1.0),
- a short description of what you were doing and what happened,
- the **case / acknowledgement number** if relevant (never email the actual NCRP
  file or victim data — describe the problem instead), and
- if asked, the log file from `%APPDATA%\FinTrace NCRP\logs\`.

---

*FinTrace NCRP is for the official use of authorised Cyber Crime Cell personnel
only. Handle all case data in accordance with your department's data-protection
and evidence-handling rules.*
