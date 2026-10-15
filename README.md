# Notation du jury — CPD Culture & Strategy 2026

Page web de notation des présentations d'équipes par les jurés, sur téléphone.
Les notes sont stockées dans le Google Sheet **JURY_ASSESSMENT** via un script Apps Script.

- `index.html` : la page (un seul fichier, à déposer sur n'importe quel hébergement statique en **https**).
- `Code.gs` : le serveur Google Apps Script, à coller dans le tableur.

## Mise en route (une fois, ~5 min)

1. Ouvrir le tableur JURY_ASSESSMENT → **Extensions → Apps Script**.
2. Remplacer le contenu de `Code.gs` par celui de ce dépôt, puis enregistrer.
3. **Déployer → Nouveau déploiement** → type **Application web**
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
   - Autoriser l'accès demandé par Google.
4. Copier l'URL de l'application web (elle se termine par `/exec`).
5. Dans `index.html`, renseigner `const API_URL = '…/exec';`.
6. Déposer `index.html` sur l'hébergement et partager le lien aux jurés.

Après une modification de `Code.gs` : **Déployer → Gérer les déploiements → Modifier → Nouvelle version** (l'URL reste la même).

## Utilisation

- **Jurés** : ils tapent le début de leur prénom et touchent leur nom. Aucun compte requis.
- **Organisateur** : taper le mot de passe à la place d'un prénom ouvre le menu **Réglages**
  (jurys, membres, équipes, critères, échelle, clôture). Mot de passe par défaut : `organisateur`, à changer dans Réglages → Accès organisateur.
- **Vue d'ensemble / Par équipe** : classement et récapitulatif, actualisés toutes les 10 s, export CSV.

## Réseau instable

Chaque note est d'abord enregistrée sur le téléphone, puis envoyée au serveur. Hors ligne, elle reste en attente
(voyant « en attente » dans l'en-tête) et part automatiquement au retour du réseau (nouvel essai toutes les 10 s).
La page s'ouvre aussi hors ligne avec les dernières données connues.

## Données dans le tableur

Le script crée deux onglets et ne touche pas aux autres :

- `APP_NOTES` : une ligne par juré × équipe (jury, membre, équipe, notes, moyenne, commentaire). Les colonnes techniques A–G sont masquées.
- `APP_CONFIG` : la configuration en JSON (cellule A1) — ne pas modifier à la main.

## Limites

- L'URL du script est publique : quelqu'un qui la connaît pourrait envoyer des notes. Ne diffuser le lien qu'aux jurés.
- Dimensionné pour un événement (~20 personnes en même temps, quelques centaines de fiches).
