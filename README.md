# Notation du jury — CPD Culture & Strategy 2026

Page web (en anglais) de notation des présentations d'équipes par les jurés, sur téléphone.
Les notes sont stockées dans le Google Sheet **JURY_ASSESSMENT** via un script Apps Script.

- `index.html` : la page, un seul fichier autonome, servie par Apps Script lui-même.
- `Code.gs` : le serveur Google Apps Script, déployé avec `clasp`.
- `config.gs` : l'ID du tableur. **Non versionné** (dépôt public) — à créer en local avec
  `const SHEET_ID = '<id du tableur>';`
- `appsscript.json` : le manifeste ; il fixe déjà « Exécuter en tant que : moi » et « Qui a accès : tout le monde ».

## Mise en route

```bash
clasp push                                 # Code.gs, config.gs, index.html, appsscript.json
clasp update-deployment <deploymentId>     # nouvelle version ; l'URL /exec ne change pas
```

L'URL `/exec` sert **la page et les données** : rien à héberger ailleurs, et aucune connexion Google
pour les jurés. `doGet()` sans paramètre renvoie `index.html` en y réécrivant `API_URL` avec sa propre
URL ; `?action=state` renvoie les données.

### Pourquoi un script autonome et pas un script lié

Le tableur vit dans un **Drive partagé**. Un script *lié* à un fichier de Drive partagé fait vérifier par
Google l'appartenance à ce Drive pour chaque visiteur **connecté** à un compte Google : la page échoue
alors avec « Impossible d'ouvrir le fichier pour le moment », alors qu'elle s'ouvre normalement en
navigation privée. Le script est donc **autonome**, dans My Drive, et ouvre le tableur par son ID — voir
`ss()` dans `Code.gs`.

Contrepartie : n'ayant pas l'accès implicite d'un script lié, il doit être autorisé **une fois** à la main.
Ouvrir le script dans le navigateur, lancer n'importe quelle fonction, accepter l'autorisation. Sans ça,
toute requête renvoie « Accès refusé — Une autorisation est nécessaire ».

## Utilisation

- **Jurés** : ils tapent le début de leur prénom et touchent leur nom. Aucun compte requis.
- **Organisateur** : taper le mot de passe à la place d'un prénom ouvre le menu **Réglages**
  (jurys, membres, équipes, critères, échelle, clôture). Mot de passe par défaut : `organisateur`, à changer dans Réglages → Accès organisateur.
- **Vue d'ensemble / Par équipe** : classement et récapitulatif, actualisés toutes les 10 s, export CSV.

## Réseau instable

Chaque note est d'abord enregistrée sur le téléphone, puis envoyée au serveur. Hors ligne, elle reste en attente
(voyant « en attente » dans l'en-tête) et part automatiquement au retour du réseau (nouvel essai toutes les 10 s).
La page s'ouvre aussi hors ligne avec les dernières données connues.

## Le tableur est la source de vérité

La liste des jurys, jurés, équipes et critères est lue **à chaque actualisation** dans le tableur :

- **Un jury = un onglet dont le nom commence par « Jury »** (`JURY 1`, `Jury 2`, `Jury 3 - finale`…). Ajouter un onglet de ce type ajoute un jury ; les autres onglets (`Pax 1`…) sont ignorés.
- **Colonne A** : groupe (équipe). Uniquement les 12 groupes **A à L** (toute autre valeur est ignorée), triés par ordre alphabétique.
- **Colonne B** : membre du jury. Valeurs distinctes, doublons et majuscules/accents ignorés.
- **Ligne 1, colonnes C et suivantes** jusqu'à `Average` / `Moyenne` / `Completion` : les critères.

Modifier le tableur suffit : la page se met à jour seule (10 s sur les écrans de synthèse, 30 s ailleurs).
Attention : renommer un juré ou un groupe crée un nouvel identifiant ; les notes déjà saisies sous l'ancien nom ne lui sont plus rattachées.

La page ne gère que : titre, échelle de notes, verrouillage, clôture, coefficients et descriptions des critères, mot de passe.

### Où vont les notes

- Dans la ligne (groupe, juré) de l'onglet `Jury N`, colonnes des critères : les formules existantes (Average, Completion, Pax…) restent à jour. Désactivable avec `WRITE_BACK = false` dans `Code.gs`.
- Dans l'onglet `APP_NOTES` (créé automatiquement) : une ligne par juré × équipe, avec moyenne et commentaire. Les colonnes techniques A–G sont masquées.
- Les réglages de la page sont dans l'onglet `APP_CONFIG` (créé automatiquement, ne pas modifier à la main).

## Limites

- L'URL du script est publique : quelqu'un qui la connaît pourrait envoyer des notes. Ne diffuser le lien qu'aux jurés.
- Dimensionné pour un événement (~20 personnes en même temps, quelques centaines de fiches).
