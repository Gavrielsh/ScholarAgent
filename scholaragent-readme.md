<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
[![LinkedIn][linkedin-shield]][linkedin-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">ScholarAgent</h3>
  <p align="center">
    An Agentic-RAG Architecture for Multi-Layered Secure Knowledge Systems.
    <br />
    <br />
    <a href="https://github.com/gavrielsh/scholaragent/issues">Report Bug</a>
    ·
    <a href="https://github.com/gavrielsh/scholaragent/issues">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#key-features">Key Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#environment-variables">Environment Variables</a></li>
      </ul>
    </li>
    <li>
      <a href="#architecture">Architecture</a>
      <ul>
        <li><a href="#authorization-model">Authorization Model</a></li>
        <li><a href="#hybrid-search">Hybrid Search</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#evaluation">Evaluation</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

ScholarAgent is an enterprise-grade, event-driven knowledge management system built as part of an M.Sc. research project. It implements a secure **Agentic-RAG (Retrieval-Augmented Generation)** architecture specifically designed for social and educational non-profit organizations. 

The system addresses the critical challenge of unauthorized data leakage in LLM applications by enforcing strict **transactional Row-Level Security (RLS)** at the database level, ensuring users only retrieve and generate responses based on content they are explicitly authorized to view.

### Key Features
*   **Four-Tier Authorization (L0-L3):** Strict hierarchical access control (Admin, Manager, Staff, Volunteer).
*   **Hybrid Retrieval:** Combines Dense Vector Search (`pgvector`) and Sparse Full-Text Search (PostgreSQL `tsvector`) using Reciprocal Rank Fusion (RRF).
*   **Zero Data Leakage:** Guaranteed by transactional database-level RLS policies.
*   **Agentic Orchestration:** Deterministic state machine (`IntentRouter`, `SafetySignals`) routing queries based on intent (Knowledge, Admin Analytics, Chat History).
*   **Multi-Provider LLM Adapter:** Built-in support for Google Gemini (1.5/2.0), Anthropic Claude (3.5), OpenAI (GPT-4o), and a Mock Provider for testing.
*   **WhatsApp Gateway:** Seamless asynchronous interaction via WhatsApp Cloud API with BullMQ/Redis queuing and HMAC-SHA256 signature verification.
*   **Automated Evaluation:** Built-in testing harness utilizing RAGAS metrics and a novel Data Leakage Score (DLS).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

*   [![Next.js][Next.js]][Next-url]
*   [![TypeScript][TypeScript.js]][TypeScript-url]
*   [![PostgreSQL][PostgreSQL.js]][PostgreSQL-url]
*   [![Redis][Redis.js]][Redis-url]
*   [![Docker][Docker.js]][Docker-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

To get a local copy up and running follow these simple steps.

### Prerequisites

*   Node.js (v20+)
*   Docker & Docker Compose
*   A WhatsApp Cloud API Developer Account
*   API Keys for LLM Providers (OpenAI, Anthropic, or Google Gemini)

### Installation

1.  Clone the repo:
    ```sh
    git clone https://github.com/gavrielsh/scholaragent.git
    cd scholaragent
    ```
2.  Install NPM packages:
    ```sh
    npm install
    ```
3.  Set up your `.env` file (see [Environment Variables](#environment-variables)).
4.  Start the infrastructure (PostgreSQL + pgvector, Redis) via Docker:
    ```sh
    docker-compose up -d
    ```
5.  Run database migrations:
    ```sh
    npm run db:migrate
    ```
6.  Start the development server and the BullMQ worker concurrently:
    ```sh
    npm run dev
    # In a separate terminal:
    npm run worker
    ```

### Environment Variables

Copy the `.env.example` file to `.env` and populate the required variables:

```env
# Database
DATABASE_URL="postgres://postgres:postgres@localhost:5432/scholaragent"

# Redis (BullMQ)
REDIS_URL="redis://localhost:6379"

# API Keys (Provide at least one)
OPENAI_API_KEY="your-openai-key"
ANTHROPIC_API_KEY="your-anthropic-key"
GEMINI_API_KEY="your-gemini-key"

# WhatsApp Configuration
WHATSAPP_VERIFY_TOKEN="your-verify-token"
WHATSAPP_APP_SECRET="your-app-secret"
WHATSAPP_PHONE_NUMBER_ID="your-phone-id"
WHATSAPP_ACCESS_TOKEN="your-access-token"
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ARCHITECTURE -->
## Architecture

### Authorization Model

The system enforces a Four-Tier Role-Based and Row-Level Access Control Model:
*   `[L0: ADMIN]` - Full system visibility, audit logs.
*   `[L1: MANAGER]` - Organizational management, branch data.
*   `[L2: STAFF]` - Operational files, internal schedules.
*   `[L3: VOLUNTEER]` - General protocols, public-facing activity guides.

Every database transaction explicitly sets the user's role and ID, allowing PostgreSQL RLS policies to dynamically filter chunks during retrieval:
```sql
SET LOCAL app.current_user_role = 'STAFF';
SET LOCAL app.current_user_id = 'user_uuid';
```

### Hybrid Search
Retrieval is performed using a combination of dense vector similarity (Cosine Distance) and sparse full-text search, fused using Reciprocal Rank Fusion (RRF):
$RRF\_Score(d) = \sum \frac{1}{60 + r(d)}$

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

### Document Ingestion
Documents placed in the `local_data/documents/` directory can be ingested into the vector database using the provided script:
```sh
npm run ingest
```
This process includes:
1. PII Redaction (removing Israeli ID numbers, emails, phones).
2. Semantic Chunking.
3. Embedding Generation.
4. Storage in PostgreSQL with `pgvector`.

### WhatsApp Interaction
Once the Webhook is configured in your Meta Developer portal, users can interact with the system via WhatsApp. The `IntentRouter` will automatically classify messages as standard queries, admin requests, or trigger `SafetySignals` for emergencies.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- EVALUATION -->
## Evaluation

The repository includes a comprehensive evaluation suite designed to benchmark the RAG system against a Golden Dataset.

Run the evaluation:
```sh
npm run eval
```

Metrics tracked:
*   **Context Precision & Recall** (via RAGAS)
*   **Faithfulness & Answer Relevancy** (via RAGAS)
*   **Data Leakage Score (DLS):** A novel metric ensuring 0% of unauthorized chunks reach the LLM context window.
*   **Latency Profiling**

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Gavriel Shalem - M.Sc. Candidate, Azrieli College of Engineering

Project Link: [https://github.com/gavrielsh/scholaragent](https://github.com/gavrielsh/scholaragent)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/gavrielsh/scholaragent.svg?style=for-the-badge
[contributors-url]: https://github.com/gavrielsh/scholaragent/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/gavrielsh/scholaragent.svg?style=for-the-badge
[forks-url]: https://github.com/gavrielsh/scholaragent/network/members
[stars-shield]: https://img.shields.io/github/stars/gavrielsh/scholaragent.svg?style=for-the-badge
[stars-url]: https://github.com/gavrielsh/scholaragent/stargazers
[issues-shield]: https://img.shields.io/github/issues/gavrielsh/scholaragent.svg?style=for-the-badge
[issues-url]: https://github.com/gavrielsh/scholaragent/issues
[license-shield]: https://img.shields.io/github/license/gavrielsh/scholaragent.svg?style=for-the-badge
[license-url]: https://github.com/gavrielsh/scholaragent/blob/main/LICENSE
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://linkedin.com/in/gavriel-shalom

[Next.js]: https://img.shields.io/badge/next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white
[Next-url]: https://nextjs.org/
[TypeScript.js]: https://img.shields.io/badge/typescript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[PostgreSQL.js]: https://img.shields.io/badge/postgresql-4169E1?style=for-the-badge&logo=postgresql&logoColor=white
[PostgreSQL-url]: https://www.postgresql.org/
[Redis.js]: https://img.shields.io/badge/redis-DC382D?style=for-the-badge&logo=redis&logoColor=white
[Redis-url]: https://redis.io/
[Docker.js]: https://img.shields.io/badge/docker-2496ED?style=for-the-badge&logo=docker&logoColor=white
[Docker-url]: https://www.docker.com/
