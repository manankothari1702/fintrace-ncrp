# FinTrace v0.2.0 — Cross-Artifact Validation Report

Generated: 2026-06-15T11:19:41.966Z

Read-only verification: the analyzer + exporters were run on the two available case files and every figure was extracted from THREE sources — the summary JSON, the generated PDF (text), and the generated Excel (cells) — and asserted to agree.

> Coverage note: only two case files exist (145 + 170). These results confirm the fixes on those two cases and are **not** release-grade coverage.

**Cross-artifact assertions:** 66 passed, 0 failed.
**Existing suites:** 4/4 passed.

Overall: ✅ **ALL CHECKS PASS**

## Case 145

PDF text extraction: reliable ✅

### A. Cash-out single-source + reconciliation

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | summary.cashed_out == ground truth | 5,44,282.95 vs 5,44,282.95 |
| ✅ PASS | cashout_analysis.total_cashout_amount == summary.cashed_out | 5,44,282.95 vs 5,44,282.95 |
| ✅ PASS | recovery_status.cashed_out == summary.cashed_out | 5,44,282.95 vs 5,44,282.95 |
| ✅ PASS | Excel Summary cash-out cell == summary.cashed_out | 5,44,282.95 vs 5,44,282.95 |
| ✅ PASS | PDF exec-summary shows cash-out Rs. 5,44,282.95 | searched "Rs. 5,44,282.95" |
| ✅ PASS | summary reconciliation cashed+hold+refund+residual == victim_loss | 10,65,298.00 vs 10,65,298.00 |
| ✅ PASS | recoverable_residual is derived max(0, loss-cashed-hold-refund) | 3,81,365.87 |
| ✅ PASS | Excel reconciliation cashed+hold+refund+residual == victim_loss | 10,65,298.00 vs 10,65,298.00 |
| ✅ PASS | Excel victim_loss == ground truth | 10,65,298.00 |
| ✅ PASS | Excel on_hold == ground truth | 1,39,649.18 |
| ✅ PASS | Excel refunded == ground truth | 0.00 |
| ✅ PASS | Excel recoverable_residual == ground truth | 3,81,365.87 |
| ✅ PASS | Key Finding #1 split (in-memory) is 51.1/13.1/35.8 | cashed 51.1 / hold 13.1 / recov 35.8 |
| ✅ PASS | Key Finding #1 is NOT the old 55.3/31.6 split | cashed_out_pct=51.1 |
| ✅ PASS | PDF text contains the 51.1/13.1/35.8 split |  |
| ✅ PASS | PDF Key Finding #1 shows cash-out Rs. 5.44L | searched "Rs. 5.44L" |

### B. Bank attribution = IFSC-authoritative

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | no letter contradicts an account's IFSC (14 IFSC-bearing accounts checked) | all consistent |
| ✅ PASS | account 00000005906495023 letter bank is Central Bank of India | letter="Central Bank of India" canonical="Central Bank of India" ifsc=CBIN0282138 |
| ✅ PASS | account 252000590337 letter bank is Suryoday Small Finance Bank | letter="Suryoday Small Finance Bank" canonical="Suryoday Small Finance Bank" ifsc=SURY0000011 |
| ✅ PASS | account 100219234781 letter bank is IndusInd Bank | letter="IndusInd Bank" canonical="IndusInd Bank" ifsc=INDB0001080 |
| ✅ PASS | account 159079012694 letter bank is IndusInd Bank | letter="IndusInd Bank" canonical="IndusInd Bank" ifsc=INDB0000421 |
| ✅ PASS | account 14751050003336 letter bank is HDFC Bank | letter="HDFC Bank" canonical="HDFC Bank" ifsc=HDFC0001475 |
| ✅ PASS | account 002261100000025 letter bank is Yes Bank | letter="Yes Bank" canonical="Yes Bank" ifsc=YESB0YBLUPI |
| ✅ PASS | account 00000044021519366 letter bank is State Bank of India | letter="State Bank of India" canonical="State Bank of India" ifsc=SBIN0064933 |
| ✅ PASS | account 890073000000688 letter bank is South Indian Bank | letter="South Indian Bank" canonical="South Indian Bank" ifsc=SIBL0000890 |
| ✅ PASS | account 92250100008713 letter bank is Bank of Baroda (group) | letter="Bank of Baroda (including Vijaya Bank and Dena Bank)" canonical="Bank of Baroda (including Vijaya Bank and Dena Bank)" ifsc=BARB0DBLJAT |
| ✅ PASS | account 20200131158023 letter bank is Bandhan Bank | letter="Bandhan Bank" canonical="Bandhan Bank" ifsc=BDBL0002532 |
| ✅ PASS | NO "Union Bank" letter addresses account 00000005906495023 | none |
| ✅ PASS | NO "Jio Payments" letter addresses account 252000590337 | none |
| ✅ PASS | letter count == 15 | got 15 |
| ✅ PASS | per-letter amounts sum to lien_table_total 4,34,394.61 | 4,34,394.61 |

### C. Data-quality flags

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | summary.bank_flags_count > 0 | 45 |
| ✅ PASS | bank_flags_count == data_quality rows | 45 vs 45 |
| ✅ PASS | Excel Data Quality sheet rows == data_quality rows | 45 vs 45 |
| ✅ PASS | PDF Data Quality count == data_quality rows | pdf=45 vs 45 |
| ✅ PASS | every flag is one of the 4 known flag values | all valid |
| ✅ PASS | every data-quality row is semantically consistent with its flag | all consistent |
| ✅ PASS | every letter with a flagged account carries the Annexure-H reviewer note | notes=14 vs letters-with-flag=14 |

### D. Duplicate-row dedup

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | account 100219234781 cash-out collapses to 10,000.00 (not 50,000) | 10,000.00 |
| ✅ PASS | account 100219234781 lien == 40,000.00 | 40,000.00 |
| ✅ PASS | two rows sharing a UTR but differing in amount are NOT collapsed | duplicate_count=0, unique=2 |
| ✅ PASS | two byte-identical rows DO collapse (positive control) | duplicate_count=1 |

### E. No financial drift from the bank fix

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | victim_loss unchanged (1,065,298.00) | 10,65,298.00 |
| ✅ PASS | lien_table_total unchanged (434,394.61) | 4,34,394.61 |
| ✅ PASS | layers unchanged (7) | 7 |
| ✅ PASS | total transactions unchanged (151) | 151 |

## Case 170

PDF text extraction: reliable ✅

### A. Cash-out single-source + reconciliation

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | summary.cashed_out == ground truth | 38,841.78 vs 38,841.78 |
| ✅ PASS | cashout_analysis.total_cashout_amount == summary.cashed_out | 38,841.78 vs 38,841.78 |
| ✅ PASS | recovery_status.cashed_out == summary.cashed_out | 38,841.78 vs 38,841.78 |
| ✅ PASS | Excel Summary cash-out cell == summary.cashed_out | 38,841.78 vs 38,841.78 |
| ✅ PASS | PDF exec-summary shows cash-out Rs. 38,841.78 | searched "Rs. 38,841.78" |
| ✅ PASS | summary reconciliation cashed+hold+refund+residual == victim_loss | 15,48,900.00 vs 15,48,900.00 |
| ✅ PASS | recoverable_residual is derived max(0, loss-cashed-hold-refund) | 8,30,900.04 |
| ✅ PASS | Excel reconciliation cashed+hold+refund+residual == victim_loss | 15,48,900.00 vs 15,48,900.00 |
| ✅ PASS | Excel victim_loss == ground truth | 15,48,900.00 |
| ✅ PASS | Excel on_hold == ground truth | 6,79,158.18 |
| ✅ PASS | Excel refunded == ground truth | 0.00 |
| ✅ PASS | Excel recoverable_residual == ground truth | 8,30,900.04 |

### B. Bank attribution = IFSC-authoritative

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | no letter contradicts an account's IFSC (610 IFSC-bearing accounts checked) | all consistent |

### C. Data-quality flags

| Result | Check | Detail |
|---|---|---|
| ✅ PASS | summary.bank_flags_count > 0 | 1141 |
| ✅ PASS | bank_flags_count == data_quality rows | 1141 vs 1141 |
| ✅ PASS | Excel Data Quality sheet rows == data_quality rows | 1141 vs 1141 |
| ✅ PASS | PDF Data Quality count == data_quality rows | pdf=1141 vs 1141 |
| ✅ PASS | every flag is one of the 4 known flag values | all valid |
| ✅ PASS | every data-quality row is semantically consistent with its flag | all consistent |
| ✅ PASS | every letter with a flagged account carries the Annexure-H reviewer note | notes=51 vs letters-with-flag=51 |

### Letter → Bank → IFSC (for human review)

| Letter bank | Account | IFSC |
|---|---|---|
| AU Small Finance Bank | 2251253339053700 | AUBL0002346 |
| AU Small Finance Bank | 20100003712961 | AUBL000FNCR |
| Abhyudaya Co-operative Bank | 016011100068758 | ABHY0065016 |
| Airtel Payments Bank | 7668686924 | AIRP0000001 |
| Airtel Payments Bank | 7017131477 | AIRP0000001 |
| Airtel Payments Bank | 1285353305 | AIRP0000001 |
| Airtel Payments Bank | 7489293870 | AIRP0000001 |
| Airtel Payments Bank | 8348350972 | AIRP0000001 |
| Airtel Payments Bank | 8105715305 | airp0000001 |
| Airtel Payments Bank | 7494014481 | AIRP0000001 |
| Airtel Payments Bank | 1285903337 | AIRP0000001 |
| Airtel Payments Bank | 8303123440 | AIRP0000001 |
| Airtel Payments Bank | 9571763295 | AIRP0000001 |
| Airtel Payments Bank | 9902536052 | AIRP0000001 |
| Airtel Payments Bank | 1000020019 | — |
| Airtel Payments Bank | 9837040916 | AIRP0000001 |
| Airtel Payments Bank | 6003225492 | AIRP0000001 |
| Airtel Payments Bank | 8603741004 | AIRP0000001 |
| Airtel Payments Bank | 6202493460 | AIRP0000001 |
| Airtel Payments Bank | 7536867060 | AIRP0000001 |
| Airtel Payments Bank | 9724830114 | AIRP0000001 |
| Airtel Payments Bank | 9050267080 | AIRP0000001 |
| Airtel Payments Bank | 8837088383 | AIRP0000001 |
| Airtel Payments Bank | 9546525061 | AIRP0000001 |
| Airtel Payments Bank | 7354488708 | AIRP0000001 |
| Airtel Payments Bank | 7780250813 | AIRP0000001 |
| Airtel Payments Bank | 7029736232 | AIRP0000001 |
| Airtel Payments Bank | 8972384456 | AIRP0000001 |
| Airtel Payments Bank | 6371892821 | AIRP0000001 |
| Airtel Payments Bank | 8435415073 | AIRP0000001 |
| Airtel Payments Bank | 9692102709 | AIRP0000001 |
| Airtel Payments Bank | 9774498661 | AIRP0000001 |
| Airtel Payments Bank | 9704262511 | AIRP0000001 |
| Airtel Payments Bank | 7081362908 | AIRP0000001 |
| Airtel Payments Bank | 7977564475 | AIRP0000001 |
| Airtel Payments Bank | 8473966981 | AIRP0000001 |
| Airtel Payments Bank | 6266887507 | AIRP0000001 |
| Airtel Payments Bank | 9123288013 | AIRP0000001 |
| Airtel Payments Bank | 9105131367 | airp0000001 |
| Axis Bank | 925010037467392 | UTIB0000005 |
| Axis Bank | 924020028168727 | UTIB0003235 |
| Axis Bank | 101012901334 | UTIB0000101 |
| Axis Bank | 924020045233664 | UTIB0001336 |
| Axis Bank | 923010003564405 | UTIB0001870 |
| Axis Bank | 920020016314239 | UTIB0003028 |
| Axis Bank | 917010036824210 | UTIB0001558 |
| Axis Bank | 925020030818864 | UTIB0000301 |
| Axis Bank | 925020023701504 | UTIB0005320 |
| Axis Bank | 924020011123146 | utib0002073 |
| Axis Bank | 917020056871251 | utib0000846 |
| Axis Bank | 916010080949133 | UTIB0001839 |
| Axis Bank | 924010072198122 | UTIB0005398 |
| Axis Bank | 924020007330961 | UTIB0000022 |
| Axis Bank | 925020049827361 | UTIB0002321 |
| Axis Bank | 924030043743397 | UTIB0000401 |
| Axis Bank | 924010035034564 | UTIB0002241 |
| Axis Bank | 925020044007216 | UTIB0000001 |
| Axis Bank | 925020048028981 | UTIB0002029 |
| Axis Bank | 920010010671876 | UTIB0003640 |
| Axis Bank | 924020050136723 | UTIB0001497 |
| Axis Bank | 921010039827211 | UTIB0000384 |
| Axis Bank | 923020066154431 | UTIB0002307 |
| Axis Bank | 925020050042861 | UTIB0000355 |
| Axis Bank | 923010030836434 | UTIB0000512 |
| Axis Bank | 912030003384630 | UTIB0001242 |
| Axis Bank | 921010000978812 | UTIB0003562 |
| Axis Bank | 925020022598657 | UTIB0004388 |
| Axis Bank | 887001023029944 | UTIB0SVAUB1 |
| Axis Bank | 918010095570270 | utib0003022 |
| Axis Bank | 925010007276100 | UTIB0002195 |
| Axis Bank | 925010038305110 | utib0000730 |
| Axis Bank | 925010034356220 | UTIB0004514 |
| Axis Bank | 10001291013360 | UTIB0000100 |
| Axis Bank | 922010032711790 | UTIB0002002 |
| Axis Bank | 923010040519459 | UTIB0000379 |
| Bandhan Bank | 50230018809581 | BDBL0001526 |
| Bandhan Bank | 50230019225822 | BDBL0002159 |
| Bandhan Bank | 50230021477828 | BDBL0002200 |
| Bandhan Bank | 50160013501223 | BDBL0001259 |
| Bandhan Bank | 20100061373140 | BDBL0001710 |
| Bandhan Bank | 50170018858875 | BDBL0001380 |
| Bank of Baroda (Including Vijaya Bank and Dena Bank) | 111143523817 | — |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 84340100000516 | BARB0VJKLUR |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 94631500004235 | BARB0BUPGBX |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 50318100015972 | BARB0PATFAT |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 11130200000310 | barb0petcoi |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 393156889832 | BARB0RAWATB |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 39060100008427 | BARB0KRIBHA |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | XXXXXXXX125989 | BARB0BUPGBX |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 02750100011460 | BARB0OLPADX |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 66110100001434 | BARB0BUPGBX |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 70990100016774 | BARB0DBDHLE |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 24170100011864 | BARB0PILIKO |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 38898100018451 | BARB0SUKHAL |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 02598100002784 | BARB0BHAGAT |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 67060100010549 | BARB0DBISAR |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 09260100020640 | BARB0HARDWA |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 36280100039224 | BARB0SAIULH |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 34698100008200 | BARB0HINDOL |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 66070100003632 | BARB0VJLAUL |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 41110100007159 | BARB0LALRAN |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 26880100012909 | BARB0BLYALI |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 57578100019457 | BARB0DALKHO |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 67530100000550 | BARB0DAMAOD |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 80580100009869 | BARB0VJSULT |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 08660100043800 | BARB0GANPOR |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 01190100030063 | BARB0SHRIMA |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 03148100006650 | BARB0UNDELX |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 56590100051736 | BARB0CHAKRO |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 07020100025593 | BARB0KHUDAG |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 43968100006869 | BARB0RENUKO |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 13270100030144 | BARB0MANCHI |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 07920100021224 | BARB0INDNAR |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 22598100017077 | BARB0PAKHAR |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 23970100008218 | BARB0CHASGA |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 23690100016554 | BARB0ALTAKA |
| Bank of Baroda (including Vijaya Bank and Dena Bank) | 62640100004447 | BARB0VJNETT |
| Bank of India | 836910110006734 | BKID0008369 |
| Bank of India | 668910110007173 | BKID0006689 |
| Bank of India | 814618210001819 | BKID0008505 |
| Bank of India | 756410110005733 | BKID0007564 |
| Bank of India | 752210110004034 | BKID0007522 |
| Bank of India | 434910110008972 | BKID0004349 |
| Bank of India | 864010110017064 | BKID0008640 |
| Bank of India | 883610110005366 | BKID0008836 |
| Bank of India | 913210110003081 | BKID0009132 |
| Bank of India | 478318210005614 | BKID0004783 |
| Bank of India | 479210510001567 | BKID0004792 |
| Bank of India | 760918210033976 | bkid0007609 |
| Bank of Maharashtra | 60552238835 | mahb0001689 |
| Bank of Maharashtra | 60554329742 | mahb0001551 |
| Bank of Maharashtra | 60547942997 | MAHB0000010 |
| Bank of Maharashtra | 60547774599 | MAHB0001433 |
| CSB Bank | 0843020000022 | CSBK0000355 |
| CSB Bank | 619010168908 | CSBK0000619 |
| CSB Bank | 838020537493 | CSBK0000838 |
| Canara Bank | 110105480977 | CNRB0000033 |
| Canara Bank | 110019993003 | CNRB0004532 |
| Canara Bank | 110196266800 | CNRB0001194 |
| Canara Bank | 30132010094858 | CNRB0013013 |
| Canara Bank | 71022250001570 | CNRB0004829 |
| Canara Bank | 110013188685 | CNRB0001100 |
| Canara Bank | 110216090078 | CNRB0004259 |
| Canara Bank | 110221522961 | CNRB0013082 |
| Canara Bank | 110266596104 | CNRB0000033 |
| Canara Bank | 110161886049 | CNRB0019439 |
| Canara Bank | 110278663138 | CNRB0000033 |
| Canara Bank | 19252310000219 | CNRB0011925 |
| Canara Bank | 120001349536 | CNRB0000033 |
| Canara Bank | 04602200093308 | CNRB0000033 |
| Canara Bank | 78032200043835 | CNRB0000033 |
| Canara Bank | 110139077482 | CNRB0000033 |
| Canara Bank | 90852010026780 | CNRB0018289 |
| Canara Bank | 4967101002514 | CNRB0004967 |
| Canara Bank | 110095894329 | CNRB0005871 |
| Canara Bank | 1065101117619 | CNRB0001065 |
| Canara Bank | 110158557547 | CNRB0003235 |
| Central Bank of India | 00000003259136785 | CBIN0281582 |
| Central Bank of India | 5768345775 | CBIN0282593 |
| Central Bank of India | 3857555242 | CBIN0282499 |
| Central Bank of India | 00000003422434096 | CBIN0280756 |
| Central Bank of India | 3587937146 | CBIN0283432 |
| Central Bank of India | 3284403957 | CBIN0282270 |
| Central Bank of India | 00000005342316703 | CBIN0281951 |
| Central Bank of India | 00000003918209625 | CBIN0283157 |
| Central Bank of India | 00000003513307938 | CBIN0280795 |
| Central Bank of India | 3541519610 | CBIN0280433 |
| Citibank | CITIG012111 | CITI0100000 |
| Ease Buzz | Na | — |
| Federal Bank | 23640200004816 | FDRL0002364 |
| Federal Bank | 55550103616205 | FDRL0005555 |
| Federal Bank | 10920100208518 | FDRL0001092 |
| Federal Bank | 10940100333637 | FDRL0001094 |
| Federal Bank | 21970100030393 | FDRL0002197 |
| Fino Payments Bank | 3218000336 | FINO0000001 |
| Fino Payments Bank | 20262866302 | FINO0000001 |
| Fino Payments Bank | 20410948413 | FINO0000001 |
| Fino Payments Bank | 20325406361 | FINO0001596 |
| Fino Payments Bank | 3218000283 | FINO0000001 |
| Gujarat State Co-operative Bank | 195003973120 | GSCB0PDC019 |
| Gujarat State Co-operative Bank | 114016908660 | GSCB0RJT165 |
| Gujarat State Co-operative Bank | 118002201115 | GSCB0BKD041 |
| Gujarat State Co-operative Bank | 44910052001003882 | GSCB0ASCB02 |
| HDFC Bank | 50100261608427 | HDFC0001997 |
| HDFC Bank | 50100709027010 | HDFC0001765 |
| HDFC Bank | 57500001372151 | HDFC0MERUPI |
| HDFC Bank | 50100676669680 | HDFC0006225 |
| HDFC Bank | 50100835369852 | hdfc0001202 |
| HDFC Bank | 00030310016252 | HDFC0MERUPI |
| HDFC Bank | 99992233778889 | HDFC0001068 |
| HDFC Bank | 50100120418080 | HDFC0000973 |
| HDFC Bank | 50100773779859 | HDFC0009656 |
| HDFC Bank | 50100476576120 | HDFC0001059 |
| HDFC Bank | 50100635642667 | HDFC0002364 |
| HDFC Bank | 50200073371061 | HDFC0MERUPI |
| HDFC Bank | 99999286141515 | HDFC0006395 |
| HDFC Bank | 50100291916276 | HDFC0004436 |
| HDFC Bank | 50100737574261 | HDFC0009295 |
| HDFC Bank | 50200097639877 | HDFC0006873 |
| HDFC Bank | 50200037756907 | HDFC0002430 |
| HDFC Bank | 50200076145538 | HDFC0MERUPI |
| HDFC Bank | 50100393181362 | HDFC0004843 |
| HDFC Bank | 99998668182673 | HDFC0MERUPI |
| HSBC Bank | 074243007006 | HSBC0560002 |
| ICICI Bank | 006001028732 | ICIC0000060 |
| ICICI Bank | 039305007322 | ICIC0DC0099 |
| ICICI Bank | 184601506773 | icic0001846 |
| ICICI Bank | 031405006035 | ICIC0002449 |
| ICICI Bank | 256105004604 | ICIC0002561 |
| ICICI Bank | 007601583245 | ICIC0000076 |
| ICICI Bank | 107501543320 | ICIC0001075 |
| ICICI Bank | 108605001499 | ICIC0000026 |
| ICICI Bank | 100705001479 | ICIC0001007 |
| ICICI Bank | BCOS061014103 | ICIC0000104 |
| ICICI Bank | 006102860012362 | ICIC00CCBLT |
| ICICI Bank | 123101507402 | ICIC0001231 |
| ICICI Bank | 776805000298 | ICIC0DC0099 |
| ICICI Bank | cca2004008@icici | ICIC0DC0099 |
| ICICI Bank | 188905000298 | ICIC0DC0099 |
| IDBI Bank | 0579102000014827 | IBKL0000579 |
| IDFC FIRST Bank | 10234437053 | IDFB0020101 |
| IDFC FIRST Bank | 10226567843 | IDFB0020101 |
| IDFC FIRST Bank | 10238675152 | IDFB0040101 |
| IDFC FIRST Bank | 10084554683 | IDFB0080303 |
| IDFC FIRST Bank | 10237798288 | IDFB0080152 |
| India Post Payments Bank | 005910016782 | IPOS0000001 |
| India Post Payments Bank | 052910109992 | IPOS0000001 |
| India Post Payments Bank | 055010805674 | IPOS0000001 |
| India Post Payments Bank | 058110309645 | IPOS0000001 |
| India Post Payments Bank | 064910056307 | IPOS0000001 |
| India Post Payments Bank | 0009510524048 | IPOS0000001 |
| India Post Payments Bank | 009510367707 | IPOS0000001 |
| India Post Payments Bank | 009110209727 | IPOS0000001 |
| India Post Payments Bank | 031510144145 | IPOS0000001 |
| India Post Payments Bank | 035110104647 | IPOS0000001 |
| India Post Payments Bank | 031010102968 | IPOS0000001 |
| India Post Payments Bank | 005310195951 | IPOS0000001 |
| India Post Payments Bank | 030410104819 | IPOS0000001 |
| India Post Payments Bank | 007910459310 | IPOS0000001 |
| India Post Payments Bank | 031910217196 | IPOS0000001 |
| India Post Payments Bank | 020910285652 | IPOS0000001 |
| India Post Payments Bank | 061010593933 | IPOS0000001 |
| India Post Payments Bank | 022110111476 | IPOS0000001 |
| India Post Payments Bank | 017710026747 | IPOS0000001 |
| India Post Payments Bank | 004410260295 | IPOS0000001 |
| India Post Payments Bank | 007610798793 | IPOS0000001 |
| India Post Payments Bank | 005810255305 | IPOS0000001 |
| India Post Payments Bank | 058610117830 | IPOS0000001 |
| India Post Payments Bank | 004010213735 | IPOS0000001 |
| India Post Payments Bank | 008710222471 | IPOS0000001 |
| India Post Payments Bank | 046210115013 | IPOS0000001 |
| Indian Bank | 8186770398 | IDIB000K593 |
| Indian Bank | 6764464427 | IDIB000A201 |
| Indian Bank | 6274240561 | IDIB000P200 |
| Indian Bank | 7440785882 | IDIB000D010 |
| Indian Bank | 8130566092 | IDIB000D682 |
| Indian Bank | 7905012328 | IDIB000V541 |
| Indian Bank | 6536436160 | IDIB000V056 |
| Indian Bank | 7092448375 | IDIB000C129 |
| Indian Bank | 8163435926 | IDIB000S288 |
| Indian Bank | 50305081007 | IDIB000N549 |
| Indian Bank | 50254601931 | IDIB000D627 |
| Indian Bank | 7786137214 | IDIB000S721 |
| Indian Bank | 477476849 | IDIB000A016 |
| Indian Bank | 615292177 | IDIB000A016 |
| Indian Bank | 8026049799 | IDIB000P608 |
| Indian Bank | 6074878511 | IDIB000V056 |
| Indian Overseas Bank | 147801000015231 | IOBA0001478 |
| Indian Overseas Bank | 225001000012846 | IOBA0002250 |
| Indian Overseas Bank | 015602000001671 | IOBA0000156 |
| Indian Overseas Bank | 042802000000555 | IOBA0000428 |
| Indian Overseas Bank | 199202000015780 | IOBA0001992 |
| Indian Overseas Bank | 199102000016125 | IOBA0001991 |
| Indian Overseas Bank | 190801000000638 | IOBA0001908 |
| Indian Overseas Bank | 032502000001250 | IOBA0000325 |
| Indian Overseas Bank | 362802000000175 | IOBA0003628 |
| Indian Overseas Bank | 105701000072447 | IOBA0001057 |
| Indian Overseas Bank | 006102000010813 | IOBA0000061 |
| Indian Overseas Bank | 272801000002759 | IOBA0002728 |
| Indian Overseas Bank | 068002000001615 | IOBA0000680 |
| Indian Overseas Bank | 142502000002094 | IOBA0001425 |
| Indian Overseas Bank | 395002000000060 | IOBA0003950 |
| Indian Overseas Bank | 059602000006015 | IOBA0000596 |
| Indian Overseas Bank | 184202000000753 | IOBA0001842 |
| Indian Overseas Bank | 397102000000001 | IOBA0003971 |
| Indian Overseas Bank | 125302000002323 | IOBA0001253 |
| IndusInd Bank | 257022111300 | INDB0002214 |
| IndusInd Bank | 201016610784 | INDB0001548 |
| IndusInd Bank | 201012252786 | INDB0001389 |
| IndusInd Bank | 201024107841 | INDB0001854 |
| IndusInd Bank | 100249597511 | INDB0001076 |
| IndusInd Bank | 917877678430 | PPIW0881822 |
| IndusInd Bank | 201025971146 | INDB0001854 |
| IndusInd Bank | 100228514089 | INDB0000504 |
| IndusInd Bank | 201015140419 | INDB0001548 |
| IndusInd Bank | 100223760269 | INDB0000396 |
| IndusInd Bank | 100194189601 | INDB0000493 |
| IndusInd Bank | 00993564615950 | INDB0MERCHA |
| IndusInd Bank | 201014799096 | INDB0000312 |
| Jammu and Kashmir Bank | 0210040800003584 | JAKA0KISHEN |
| Jammu and Kashmir Bank | 1238040800002011 | JAKA0ESANIK |
| Jammu and Kashmir Bank | 0138021360000019 | JAKA0SOGAAM |
| Jammu and Kashmir Bank | 0044020100000577 | jaka0dooroo |
| Jammu and Kashmir Bank | 0036021360000289 | JAKA0BEERWA |
| Jammu and Kashmir Bank | 0120010100001030 | JAKA0SHIMLA |
| Jammu and Kashmir Bank | 0012041000001277 | JAKA0FOREST |
| Jammu and Kashmir Bank | 0783040150003790 | JAKA0WACHII |
| Jammu and Kashmir Bank | 0054010100005473 | JAKA0GOLDEN |
| Jammu and Kashmir Bank | 0055010100008004 | JAKA0CIRCUS |
| Jio Payments Bank | 002070251000009 | JIOP0000001 |
| Jio Payments Bank | 002070861000002 | JIOP0000001 |
| Jio Payments Bank | 003521731171109 | JIOP0000001 |
| Jio Payments Bank | 001121711189652 | JIOP0000001 |
| Jio Payments Bank | 002071041000032 | JIOP0000001 |
| Jio Payments Bank | 002071121000093 | JIOP0000001 |
| Jio Payments Bank | 003321714263586 | JIOP0000001 |
| Jio Payments Bank | 003321714337016 | JIOP0000001 |
| Karnataka Bank | 6032500102304901 | KARB0000603 |
| Karnataka Gramin Bank | 10536101017636 | PKGB0010536 |
| Karnataka Gramin Bank | 12217111000070 | PKGB0012217 |
| Karur Vysya Bank | 1481166000060218 | KVBL0001481 |
| Kerala State Co-operative Bank | 166410801200274 | KSBK0001664 |
| Kerala State Co-operative Bank | 132810801200017 | KSBK0001328 |
| Kotak Mahindra Bank | 6347198257 | KKBK0002791 |
| Kotak Mahindra Bank | 7450841290 | KKBK0000001 |
| Kotak Mahindra Bank | FPPI31a8fdd06cb5 | PPIW0884509 |
| Kotak Mahindra Bank | 134010229370 | KKBK0008042 |
| Kotak Mahindra Bank | 8250181326 | KKBK0001381 |
| Kotak Mahindra Bank | 1213557589 | KKBK0007488 |
| Kotak Mahindra Bank | 3546613444 | KKBK0007676 |
| Kotak Mahindra Bank | 5747286946 | KKBK0002798 |
| Kotak Mahindra Bank | 4749355216 | KKBK0005935 |
| Kotak Mahindra Bank | 3912936467 | kkbk0004335 |
| Kotak Mahindra Bank | 3448865422 | KKBK0000958 |
| Kotak Mahindra Bank | 5945800456 | KKBK0001752 |
| Kotak Mahindra Bank | 6348908008 | KKBK0000285 |
| Kotak Mahindra Bank | 0548396313 | KKBK0000811 |
| Kotak Mahindra Bank | 2549599434 | KKBK0000253 |
| Kotak Mahindra Bank | 7151243140 | KKBK0003543 |
| Kotak Mahindra Bank | 2746747683 | KKBK0000001 |
| Maharashtra Gramin Bank | 80068220455 | MAHG0004307 |
| NSDL Payments Bank | 502004099036 | NSPB0000015 |
| NSDL Payments Bank | 501053933880 | NSPB0000002 |
| NSDL Payments Bank | 501044126051 | NSPB0000002 |
| NSDL Payments Bank | 501053861389 | NSPB0000002 |
| NSDL Payments Bank | 501035462704 | NSPB0000002 |
| NSDL Payments Bank | 501054596598 | NSPB0000002 |
| NSDL Payments Bank | 501053377505 | NSPB0000002 |
| NSDL Payments Bank | 501052012185 | NSPB0000002 |
| NSDL Payments Bank | 10000093335 | NSPB0000011 |
| NSDL Payments Bank | 502003806105 | NSPB0000016 |
| NSDL Payments Bank | 501053650030 | NSPB0000002 |
| North East Small Finance Bank | 033325222160884 | NESF0000333 |
| North East Small Finance Bank | 033325221825316 | NESF0000333 |
| Paytm | NA | — |
| Paytm | referremark | — |
| Paytm | RR | — |
| PhonePe | BillNumber042000010134 | NA |
| PhonePe | Rechargenumber8448210157 | — |
| PhonePe | Mobilenumber9669499795 | — |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0793208100657578 | PUNB0079320 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 7108010292962 | PUNB0RRBAGB |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 3161000109272650 | PUNB0316100 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 95921500008504 | PUNB0SUPGB5 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 8119010071646 | PUNB0RRBTGB |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 7371026015600 | PUNB0RRBAGB |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 72240100189671 | PUNB0MBGB06 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0053300100001036 | PUNB0005330 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 9162000100048685 | PUNB0916200 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0053101700251175 | PUNB0005310 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 1729102100001890 | PUNB0172910 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 73070100062752 | PUNB0MBGB06 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 1312010262798 | PUNB0131220 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 86002724057 | PUNB0PGB003 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 7871001700007055 | PUNB0787100 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 3550001700011982 | punb0355000 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 1645201700148450 | PUNB0164520 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0033201700106973 | PUNB0003320 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0601010933162 | PUNB0060120 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 77060100029121 | PUNB0HGB001 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0362201700027062 | PUNB0036220 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 7304010021623 | PUNB0RRBAGB |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0360001700029545 | PUNB0036000 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 3408000110045602 | PUNB0340800 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 07712413000040 | PUNB0077110 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0199000109120150 | PUNB0019900 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 3285001507003150 | PUNB0328500 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 9234001700134785 | punb0923400 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0001001500040294 | PUNB0000100 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 2679001700181585 | PUNB0267900 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0367201700139348 | punb0036720 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0155000104323882 | PUNB0015500 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 1610001700016595 | PUNB0161000 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 2238001700246049 | PUNB0223800 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0459201700246109 | PUNB0045920 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 2507000100213074 | PUNB0250700 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 4929000100142349 | PUNB0492900 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 7393000100074338 | PUNB0739300 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0568001700302099 | PUNB0056800 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 89420100020290 | PUNB0HPGB04 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 9759000100025374 | PUNB0975900 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 2249000108079343 | PUNB0224900 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 6890001700077142 | PUNB0689000 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0692010453004 | PUNB0069220 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 78622100000056 | PUNB0HGB001 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 0953200100004259 | PUNB0095320 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 1429100100006336 | PUNB0142910 |
| Punjab National Bank (including Oriental Bank of Commerce and Un | 4757001700064283 | PUNB0475700 |
| Punjab Sind Bank | 11931000006146 | PSIB0021193 |
| Punjab Sind Bank | 05041000019261 | psib0000504 |
| RBL Bank | 409002200157 | RATN0000049 |
| RBL Bank | 2541109900110192 | RATN0000990 |
| RBL Bank | 2541109900110151 | RATN000RAPL |
| Rajasthan Marudhara Gramin Bank | 21506177740 | RMGB0000001 |
| Rajasthan Marudhara Gramin Bank | 83077791596 | RMGB0000275 |
| Rajasthan Marudhara Gramin Bank | 83066517957 | RMGB0000253 |
| Rajasthan Marudhara Gramin Bank | 83071951138 | RMGB0000118 |
| Rajasthan Marudhara Gramin Bank | 21611046990 | RMGB0000001 |
| Razorpay | RnACk0oaBCKtya | — |
| Razorpay | IgnuOmEhIbJMJM | — |
| Razorpay | QGYGfF0LpX8dVX | — |
| Slice Small Finance Bank | 00000033129302435 | PHONEPE |
| Slice Small Finance Bank | 00000041604276809 | PAYTM |
| Slice Small Finance Bank | 9692464349@ybl | — |
| State Bank of India | 00000035098279705 | SBIN0040103 |
| State Bank of India | 00000044662078932 | SBIN0018542 |
| State Bank of India | 00000044623264028 | SBIN0004596 |
| State Bank of India | 00000030881707273 | SBIN0000631 |
| State Bank of India | 43701572916 | SBIN0005944 |
| State Bank of India | 00000041812481448 | SBIN0014617 |
| State Bank of India | 00000033568063040 | SBIN0005639 |
| State Bank of India | 00000037172117703 | SBIN0020240 |
| State Bank of India | 00000042496030527 | SBIN0004191 |
| State Bank of India | 00000044599857158 | SBIN0031565 |
| State Bank of India | 00000037212681587 | SBIN0032248 |
| State Bank of India | 00000034251351109 | SBIN0005381 |
| State Bank of India | 00000042218024309 | SBIN0009550 |
| State Bank of India | 00000035866142180 | SBIN0060308 |
| State Bank of India | 00000044471381297 | SBIN0000051 |
| State Bank of India | 00000041692053323 | SBIN0010932 |
| State Bank of India | 36086662742 | SBIN0000206 |
| State Bank of India | 00000038705770343 | SBIN0000085 |
| State Bank of India | 00000041387563671 | SBIN0000221 |
| State Bank of India | 00000039665583601 | SBIN0011326 |
| State Bank of India | 34916994228 | SBIN0014257 |
| State Bank of India | 00000020151167366 | SBIN0006093 |
| State Bank of India | 00000044666320459 | SBIN0013250 |
| State Bank of India | 00000041744872573 | SBIN0011387 |
| State Bank of India | 00000042585553604 | SBIN0003624 |
| State Bank of India | 00000033055437475 | SBIN0011026 |
| State Bank of India | 00000064166422701 | SBIN0018714 |
| State Bank of India | 00000010697801627 | SBIN0002095 |
| State Bank of India | 00000057065001213 | SBIN0070859 |
| State Bank of India | 00000042987900642 | SBIN0013420 |
| State Bank of India | 35918809556 | SBIN0000106 |
| State Bank of India | 42015311189 | SBIN0002925 |
| State Bank of India | 41675085969 | SBIN0018428 |
| State Bank of India | 40246322599 | SBIN0005243 |
| State Bank of India | 40870617820 | SBIN0031058 |
| State Bank of India | 34231232277 | SBIN0007786 |
| State Bank of India | 35442380262 | SBIN0008176 |
| State Bank of India | 00000041593344086 | SBIN0004659 |
| State Bank of India | 00000034727655100 | SBIN0009631 |
| State Bank of India | 00000039245634372 | SBIN0002643 |
| State Bank of India | 00000034011002913 | SBIN0002934 |
| State Bank of India | 35339465816 | SBIN0013331 |
| State Bank of India | 00000011189062200 | SBIN0000084 |
| State Bank of India | 61216826530 | sbin0004509 |
| State Bank of India | 00000035261666304 | SBIN0014066 |
| State Bank of India | 00000033575353741 | SBIN0006375 |
| State Bank of India | 00000043323592332 | SBIN0014154 |
| State Bank of India | 00000062308245432 | SBIN0020236 |
| State Bank of India | 41943554101 | SBIN0060324 |
| State Bank of India | 00000061275239359 | SBIN0032471 |
| State Bank of India | 4899221162097 | SBIN0016209 |
| State Bank of India | 32173463408 | SBIN0001460 |
| State Bank of India | 00000020250154422 | SBIN0002720 |
| State Bank of India | 00000030702831162 | SBIN0012009 |
| State Bank of India | 00000042379038522 | SBIN0005931 |
| State Bank of India | 00000038336280268 | SBIN0008088 |
| State Bank of India | 00000035799650880 | SBIN0012370 |
| State Bank of India | 00000041547419627 | SBIN0005390 |
| State Bank of India | 44588848613 | SBIN0002563 |
| State Bank of India | 00000039840840999 | SBIN0031058 |
| State Bank of India | 20012206854301 | STCB0000065 |
| State Bank of India | 00000033538795966 | SBIN0015532 |
| State Bank of India | 00000043796748620 | SBIN0000082 |
| State Bank of India | 00000040635949562 | SBIN0001026 |
| State Bank of India | XXXXXX0329 | SBIN0005477 |
| State Bank of India | 40622407160 | SBIN0013270 |
| State Bank of India | 41357849522 | SBIN0008256 |
| State Bank of India | 00000042527498222 | SBIN0060022 |
| State Bank of India | 00000043403378667 | SBIN0010139 |
| State Bank of India | 39406840747 | SBIN0010729 |
| State Bank of India | 00000044670677356 | SBIN0012352 |
| State Bank of India | 35316508042 | SBIN0001433 |
| State Bank of India | 00000097014087114 | SBIN0RRMIGB |
| State Bank of India | 41528477138 | SBIN0016515 |
| State Bank of India | 00000077066881333 | SBIN0RRCHGB |
| State Bank of India | 39961394800 | SBIN0000130 |
| State Bank of India | 00000044465356100 | SBIN0000385 |
| State Bank of India | 00000038441806642 | SBIN0008462 |
| State Bank of India | 00000044508732941 | SBIN0005652 |
| State Bank of India | 41397493554 | SBIN0006398 |
| State Bank of India | 43893879527 | SBIN0002592 |
| State Bank of India | 42326880834 | SBIN0000368 |
| State Bank of India | 00000030108395233 | SBIN0007154 |
| State Bank of India | 41620971165 | SBIN0020134 |
| State Bank of India | 11086069585 | SBIN0000591 |
| State Bank of India | 39432336306 | SBIN0007205 |
| State Bank of India | 97006911767 | SBIN0RRMIGB |
| State Bank of India | 37448536517 | SBIN0005427 |
| State Bank of India | 00000044402787481 | SBIN0018168 |
| State Bank of India | 00000031243289197 | SBIN0010859 |
| State Bank of India | 00000061293941641 | SBIN0031414 |
| State Bank of India | 00000043620129033 | SBIN0050098 |
| State Bank of India | 00000040610587905 | SBIN0020116 |
| State Bank of India | 00000040442873087 | SBIN0005807 |
| State Bank of India | 00000042053078698 | SBIN0003339 |
| State Bank of India | 00000038891454481 | SBIN0011245 |
| State Bank of India | 00000044354183051 | SBIN0000230 |
| State Bank of India | 00000041797461583 | SBIN0000021 |
| State Bank of India | 36694405137 | SBIN0060311 |
| State Bank of India | 00000033039750455 | SBIN0002556 |
| State Bank of India | 00000036569657316 | SBIN0000069 |
| State Bank of India | 00000039154651958 | SBIN0010902 |
| State Bank of India | 00000034028672050 | SBIN0006810 |
| State Bank of India | 41134086719 | SBIN0008887 |
| State Bank of India | 00000040710182676 | SBIN0018736 |
| State Bank of India | 00000043325086980 | SBIN0016106 |
| State Bank of India | 00000031327365359 | SBIN0002550 |
| State Bank of India | 00000061077384006 | SBIN0031085 |
| State Bank of India | 44033882293 | sbin0004314 |
| State Bank of India | 41457561788 | SBIN0003618 |
| State Bank of India | 00000042290367021 | SBIN0010936 |
| State Bank of India | 00000031992563383 | SBIN0012404 |
| State Bank of India | 35636430329 | SBIN0005477 |
| State Bank of India | 31645416063 | SBIN0006510 |
| State Bank of India | 00000041496576186 | SBIN0064259 |
| State Bank of India | 33485505175 | sbin0011058 |
| State Bank of India | 00000044288339457 | SBIN0017331 |
| State Bank of India | 00000032306501561 | SBIN0000905 |
| State Bank of India | 40431893085 | SBIN0009287 |
| State Bank of India | 00000036933369244 | SBIN0007416 |
| State Bank of India | 00000043807839698 | SBIN0002585 |
| State Bank of India | 67333007749 | SBIN0070166 |
| State Bank of India | 40728863087 | SBIN0005390 |
| State Bank of India | 42699350059 | SBIN0007484 |
| State Bank of India | 10669707764 | SBIN0010188 |
| State Bank of India | 00000039275077798 | SBIN0008710 |
| State Bank of India | 00000038806866950 | SBIN0016942 |
| State Bank of India | 00000033946731511 | SBIN0008575 |
| State Bank of India | 00000044526625292 | SBIN0005222 |
| State Bank of India | 00000020234293717 | SBIN0002825 |
| State Bank of India | 00000030235295459 | SBIN0003747 |
| State Bank of India | 00000044633894933 | SBIN0007626 |
| State Bank of India | 00000033375408532 | SBIN0006790 |
| State Bank of India | 00000020205357289 | SBIN0006112 |
| State Bank of India | 00000044548544644 | SBIN0064812 |
| State Bank of India | 00000031930669257 | SBIN0010858 |
| State Bank of India | 00000044674610514 | SBIN0001963 |
| State Bank of India | 00000031889973557 | SBIN0007104 |
| State Bank of India | 00000044423242591 | SBIN0007865 |
| State Bank of India | 00000041139415334 | SBIN0012404 |
| State Bank of India | 43839524614 | SBIN0061303 |
| State Bank of India | 41767716540 | SBIN0000105 |
| State Bank of India | 00000039503559367 | SBIN0009170 |
| State Bank of India | 00000084005424634 | SBIN0RRVCGB |
| State Bank of India | 00000061175480628 | SBIN0031054 |
| State Bank of India | 10456453968 | SBIN0003370 |
| State Bank of India | 00000043380288947 | SBIN0020952 |
| State Bank of India | 00000035934621520 | SBIN0000968 |
| State Bank of India | 40521691951 | sbin0011003 |
| State Bank of India | 00000041601745628 | SBIN0003370 |
| State Bank of India | 00000020325802962 | SBIN0016371 |
| State Bank of India | 00000033168841960 | SBIN0005624 |
| State Bank of India | 34344309298 | sbin0002084 |
| State Bank of India | 30873602475 | SBIN0007902 |
| State Bank of India | 20110024619 | SBIN0004275 |
| State Bank of India | 44412705315 | SBIN0000001 |
| Suryoday Small Finance Bank | 10000590180106 | SURY0BK0000 |
| Suryoday Small Finance Bank | 251000252719 | sury0bk0000 |
| Suryoday Small Finance Bank | 251013106580 | SURY0000011 |
| Tamilnad Mercantile Bank | 181100050320563 | TMBL0000181 |
| Telangana State Co-operative Apex Bank | 204022010005794 | TSAB0020040 |
| UCO Bank | 00550110099483 | UCBA0000055 |
| UCO Bank | 16753211119029 | UCBA0001675 |
| UCO Bank | 07963211151593 | UCBA0000796 |
| UCO Bank | 18120110047293 | UCBA0001812 |
| UCO Bank | 04390110157893 | UCBA0000439 |
| UCO Bank | 17110110052624 | UCBA0001711 |
| UCO Bank | 35320210000823 | UCBA0003532 |
| UCO Bank | 00280110102985 | UCBA0000028 |
| UNITY SMALL FINANCE BANK | XXXXXXXXXXXXXX | — |
| UNITY SMALL FINANCE BANK | XXXXXXXXXXXXXXXX | — |
| UNITY SMALL FINANCE BANK | XXXX | — |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 024322010002482 | UBIN0902438 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 520101267449571 | UBIN0931713 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 087710100098817 | UBIN0808776 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 520101030306813 | UBIN0913758 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 623902120002850 | UBIN0562394 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 238010100091717 | UBIN0823805 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 676002010002608 | UBIN0567604 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 363702120008542 | UBIN0536377 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 707810100122008 | ANDB0CGGBHO |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 127622010000813 | UBIN0912760 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 684102120072152 | UBIN0568414 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 593802120004547 | UBIN0559385 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 442502120004485 | UBIN0544256 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 179211010000068 | UBIN0817929 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 540502010029104 | UBIN0554057 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 386602010025031 | UBIN0538663 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 334602010101163 | UBIN0533467 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 464002010043064 | UBIN0546402 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 613602010012341 | UBIN0561363 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 702802010005733 | UBIN0570281 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 616302010014425 | UBIN0561631 |
| Union Bank of India (including Andhra Bank and Corporation Bank) | 595402120000215 | UBIN0559547 |
| Yes Bank | 002261100000025 | YESB0YBLUPI |
| Yes Bank | 072052000006172 | YESB0000720 |
| Yes Bank | 002267800000666 | YESB0000022 |
| Yes Bank | 002267800000666YESB0000022 | — |
| Yes Bank | 002401820000373 | YESB0MAB001 |
| Yes Bank | 010577900000049 | YESB0000105 |
| Yes Bank | 115027600000036 | YESB0MGSUPI |
| Yes Bank | 034827000000491 | YESB0000348 |
| Yes Bank | 115063600000612 | YESB0APLUPI |
| Yes Bank | 019861100000013 | YESB0000198 |
| Yes Bank | 001677900000042 | YESB0000016 |

**170 cash-out reconciliation:** 38,841.78 cashed + 6,79,158.18 on-hold + 0.00 refunded + 8,30,900.04 residual = 15,48,900.00 (victim_loss 15,48,900.00)

## Existing test suites

| Result | Suite | Summary |
|---|---|---|
| ✅ PASS | `npx jest` | Test Suites: 14 passed, 14 total \| Tests:       254 passed, 254 total |
| ✅ PASS | `node backend/scripts/accuracy_test.js` | Final score: 30/30 checks passed |
| ✅ PASS | `node backend/scripts/consistency_test.js` | 4/4 consistency checks passed |
| ✅ PASS | `node backend/scripts/security_audit.js` | Final security score: 10/10 \| Verdict: all attack vectors contained. ✅ |
