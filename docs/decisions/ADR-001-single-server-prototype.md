# ADR-001 — Single-server prototype proposal (superseded)

**Status:** Superseded on 24 September 2026 by [ADR-010](ADR-010-cloudflare-neon-free.md). The VPS was a planning proposal only; no server was purchased or deployed.
**Originally proposed:** 24 September 2026

## Historical context

The team first considered a centralized Linux host for the web application, API, scheduler, workers and PostgreSQL. The proposed stack was React/TypeScript, FastAPI and PostgreSQL with PostGIS/pgvector, with hosted model adapters. An initial sizing placeholder was 4 vCPU, 16 GB RAM and 100 GB SSD. None of these values were measured, and no runtime implementation was made from this proposal.

The user later selected Cloudflare and Neon Free as the deployment target and asked that the plan fit their no-cost tiers. ADR-010 replaces the VPS stack and its sizing assumptions. This historical record is retained so earlier documents and decisions can be traced without treating the VPS as current scope.

## Historical trade-offs

The VPS would have offered control of long-running processes and database extensions, but required a paid host and an external backup arrangement. A single process for all responsibilities would have allowed ingestion and model work to interfere with public requests. These considerations are now informational only; they do not override the current free-tier target.
