# ⚡ Thor V2 - Interface Utilisateur (Frontend)

## 1. Gestion des Sessions
*   **Dual-Port API** : Le frontend se connecte dynamiquement au port 3000 (Réel) ou 3001 (Simulé) via `localStorage`.
*   **Session Switcher** : Un bouton global permet de basculer instantanément. Un rafraîchissement forcé garantit que les WebSockets se reconnectent au bon backend.

## 2. Indicateurs Visuels (UX/UI)
*   **Mode RÉEL** : 
    *   Bordures et Glow **ROUGES**.
    *   Titre : "THOR - SESSION RÉELLE".
    *   Badge "DANGER" sur les opérations critiques.
*   **Mode SIMULATION** :
    *   Bordures et Glow **BLEUS**.
    *   Titre : "THOR - SIMULATION".
    *   Badge "TEST" omniprésent.

## 3. Composants Clés
*   **TradeTable** : Visualisation du PnL en temps réel avec graphiques Recharts.
*   **StatsHeader** : Résumé financier (WinRate, PnL global, SOL dépensés).
*   **WalletCard** : Gestion des wallets Alphas avec labels éditables.
*   **SettingsModal** : Configuration du slippage, TP/SL et limites de sécurité.

## 4. WebSockets
*   Le client écoute les événements `trade:price`, `trade:ath` et `trade:closed` pour mettre à jour l'UI sans recharger la page.
