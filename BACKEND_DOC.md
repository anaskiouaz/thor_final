# ⚡ Thor V2 - Architecture Détaillée (Backend)

## 1. Moteur de Surveillance (Monitor)
*   **Helius WebSockets** : Écoute en temps réel les journaux (logs) des wallets configurés.
*   **RPC Polling** : Fallback toutes les 10s pour s'assurer qu'aucune transaction n'est manquée.
*   **Validation** : Les adresses sont validées via `PublicKey` avant toute tentative de connexion RPC. Les adresses de test (ex: "Alpha1...") sont ignorées par les services réseau pour éviter les erreurs `WrongSize`.

## 2. Cycle de Vie d'un Trade
1.  **Detection** : Identifie un swap ou une création de token.
2.  **Security Gate** : Analyse RugCheck + LP Burn + Mint Authority. (Ignoré pour les jetons de test).
3.  **Auto-Buy** : Exécution via Pump.fun (Bonding Curve) ou Jupiter (DEX).
4.  **Auto-Sell Engine** : Surveillance du prix toutes les 2s.
    *   **TP1/TP2** : Ventes partielles.
    *   **Trailing Stop** : Suivi de tendance.
    *   **Panic Exit** : Vente d'urgence si la liquidité chute de >40% ou si 3 baleines dumpent.

## 3. Sécurité & Fiabilité
*   **Daily Loss Circuit Breaker** : Arrêt total des achats si les pertes réalisées > X SOL sur 24h.
*   **Transactions SQLite** : Utilisation de `SAVEPOINT` pour garantir l'atomicité des opérations financières (Trade + Audit).
*   **Isolation Sessions** : Deux instances séparées par `APP_MODE` (REAL / SIMULATED).

## 4. Troubleshooting Logs
*   `Invalid public key input` : L'adresse du wallet ou du token est mal formatée (souvent dans les scripts de test).
*   `WrongSize / Invalid Param` : Une chaîne de caractères trop courte ou trop longue a été envoyée au RPC Solana.
*   `Format JWT detected` : La clé privée dans `.env` est incorrecte (souvent une clé API à la place d'une clé privée Base58).
