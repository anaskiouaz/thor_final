# ⚡ Thor V2 - Cahier des Charges & Architecture

## 1. Vision du Projet
Thor V2 est un automate de trading haute performance sur Solana conçu pour **copier les "Alpha Wallets"** avec une latence minimale. Le système doit permettre de surveiller des experts, d'acheter instantanément leurs jetons et de revendre selon une stratégie de profit/perte strictement automatisée.

## 2. Objectifs Fondamentaux
*   **Copie Ultra-Rapide** : Détection des achats via WebSockets Helius et exécution immédiate.
*   **Double Isolation (Real vs Sim)** : Possibilité de faire tourner deux instances indépendantes (Argent réel vs Simulation) pour tester des stratégies sans risque.
*   **Sécurité Native** : Protection contre les "Rugs" (retraits de liquidité) et "Honeypots".
*   **Ergonomie Senior** : Interface web intuitive pour gérer ses wallets cibles et visualiser ses profits.

## 3. Architecture Technique (Dual-Session MVP)

### 📊 Flux de Données (Isolation Totale)
*   **Mode RÉEL** : Port 3000 | DB: `tracker.db` | Préfixe Telegram: `[RÉEL]`
*   **Mode SIMULATION** : Port 3001 | DB: `simulated.db` | Préfixe Telegram: `[SIM]` | **Malus Réalisme: 1.5%**

### 🛠️ Décisions d'Ingénierie (MVP)
1.  **Vitesse de l'Éclair** : Suppression de l'algorithme "Alpha Sentiment Index" pour réduire la latence. Le bot copie l'achat dès détection.
2.  **Simulation Réaliste** : Intégration d'un malus de simulation (slippage + taxes fictives) pour éviter les faux espoirs.
3.  **Interface Unifiée** : Un seul Dashboard avec un commutateur (Switch) pour piloter les deux instances.
4.  **Notification Centralisée** : Un seul bot Telegram gère les deux flux avec des étiquettes claires.
5.  **Sécurité des Fonds (Circuit Breaker)** : Limitation des pertes quotidiennes (en SOL). Si la perte cumulée sur 24h dépasse le seuil (ex: 5 SOL), l'auto-buy est désactivé et une alerte Telegram prioritaire est envoyée.

## 🚀 Guide de Lancement (MVP)
1.  **Démarrage Réel** : `npm run start:real`
2.  **Démarrage Simulation** : `npm run start:sim`
3.  **Frontend** : `npm run dev` (Le switch permet de passer de 3000 à 3001)

---

## ❓ Questions Critiques & Challenges (Action Requise)

Afin de garantir que l'application soit la plus performante possible, voici mes questions et mes critiques sur les idées actuelles :

1.  **Le Double Frontend ?** : Voulez-vous une seule application web qui bascule entre le port 3000 et 3001, ou préférez-vous lancer deux pages différentes ? (Je recommande une interface unique avec un "Switch" clair pour éviter les erreurs).
2.  **Simulation "Trop Parfaite" ?** : Actuellement, la simulation utilise les prix réels du marché (Jupiter/DexScreener). Mais en réalité, il y a du **Slippage** (glissement de prix). Voulez-vous que j'ajoute un "Slippage fictif" de 1-2% en mode simulation pour que les résultats soient plus réalistes ?
3.  **Telegram - Doublon ?** : Si les deux instances tournent, vous allez recevoir des notifications en double. Faut-il deux bots Telegram différents ou un préfixe `[SIM]` / `[REAL]` dans les messages ?
4.  **Idée à supprimer ?** : Vous aviez mentionné une analyse de sentiment Alpha Index 3. Pour un pur copy-trading, c'est parfois **inutile** et cela rajoute de la latence. Si un Alpha achète, il faut copier, point. Voulez-vous qu'on simplifie cela pour privilégier la vitesse pure ?

**Répondez à ces points pour que les agents puissent démarrer les travaux en parallèle.**
