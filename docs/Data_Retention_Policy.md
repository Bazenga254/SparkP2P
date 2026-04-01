# SparkP2P Data Retention Policy

**Effective Date:** 1 April 2026
**Last Updated:** 1 April 2026
**Policy Owner:** SparkP2P Administration

---

## 1. Purpose

This policy defines how long SparkP2P retains personal and operational data, the reasons for those periods, and the process for secure disposal. It supports compliance with the **Kenya Data Protection Act, 2019 (DPA)**, **Anti-Money Laundering (AML)** regulations, and the requirements of financial services partners including banks and payment processors.

---

## 2. Scope

This policy applies to all data collected, processed, or stored by SparkP2P, including data held in:
- Production databases (PostgreSQL)
- Server logs
- Email and SMS communication records
- Backup systems

---

## 3. Retention Schedule

### 3.1 User Account Data

| Data Type | Retention Period | Reason |
|---|---|---|
| Full name, email, phone | Duration of account + 7 years after closure | DPA, AML obligation |
| Password hash | Duration of account only | Security — no value after account closure |
| Security question & answer | Duration of account + 7 years | Account verification / fraud investigation |
| KYC documents (if collected) | 7 years after account closure | AML/CFT regulations |
| Account status history | 7 years | Audit and compliance |

### 3.2 Financial and Transaction Data

| Data Type | Retention Period | Reason |
|---|---|---|
| All trade/order records | 7 years | AML/CFT — Financial Reporting Centre requirement |
| M-Pesa transaction references | 7 years | Regulatory and dispute resolution |
| Wallet balance history | 7 years | Audit trail |
| Settlement records | 7 years | Tax and regulatory compliance |
| Platform fee records | 7 years | Financial reporting |

### 3.3 Authentication and Access Logs

| Data Type | Retention Period | Reason |
|---|---|---|
| Login timestamps | 1 year | Security monitoring and fraud detection |
| Failed login attempts | 1 year | Security audit |
| Account lockout events | 1 year | Security audit |
| Admin action logs | 3 years | Internal audit and accountability |

### 3.4 Third-Party Credentials

| Data Type | Retention Period | Reason |
|---|---|---|
| Binance session cookies | Deleted on disconnect or account closure | No legitimate use beyond active session |
| Binance CSRF tokens | Deleted on disconnect or account closure | No legitimate use beyond active session |
| Binance 2FA secrets | Deleted on account closure | Sensitive credential — minimal retention |
| Binance fund password | Deleted on account closure | Sensitive credential — minimal retention |

### 3.5 Communications

| Data Type | Retention Period | Reason |
|---|---|---|
| Transactional emails (sent) | 3 years | Dispute resolution, proof of notification |
| SMS OTP logs | 90 days | Security audit |
| Support correspondence | 3 years | Dispute resolution |
| In-platform trade chat messages | 2 years | Dispute resolution and compliance |

### 3.6 System and Technical Data

| Data Type | Retention Period | Reason |
|---|---|---|
| Server access logs | 1 year | Security monitoring |
| Application error logs | 6 months | Debugging and operational continuity |
| Database backups | 30 days (rolling) | Disaster recovery |

---

## 4. Data Deletion Process

### 4.1 Account Closure
When a user requests account closure or is permanently suspended:
1. Binance credentials are deleted immediately
2. Personal identifiers are anonymized or deleted after the applicable retention period
3. Financial records are retained in compliance with AML requirements (7 years)

### 4.2 Routine Deletion
- Log files beyond their retention period are deleted via automated scripts on a scheduled basis
- OTP records are cleared automatically after 90 days
- Session tokens are cleared on logout or expiry

### 4.3 Secure Disposal
- Database records are hard-deleted (not soft-deleted) once the retention period expires
- Encrypted credentials are wiped using database-level deletion
- Server logs are deleted and not archived beyond the retention period

---

## 5. Data Subject Requests

If a user requests erasure of their data under the DPA:
- We will delete all data **except** what we are legally required to retain (e.g., transaction records for AML purposes)
- We will inform the user of any data we cannot delete and the legal basis for retaining it
- We will complete the deletion within **21 days** of the verified request

---

## 6. Legal Holds

In the event of an investigation, litigation, or regulatory inquiry, normal deletion schedules may be suspended for affected data. A legal hold will be documented and lifted once the matter is resolved.

---

## 7. Policy Review

This policy will be reviewed annually or whenever there is a significant change in:
- Applicable law or regulation
- Platform data collection practices
- Third-party processor relationships

---

## 8. Accountability

**Policy Owner:** SparkP2P Administration  
**Contact:** support@sparkp2p.com  
**Registered Data Controller:** [ODPC Registration Number — to be obtained]
