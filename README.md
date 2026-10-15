# Notation du jury — CPD Culture & Strategy 2026

Page web (en anglais) de notation des présentations d'équipes par les jurés, sur téléphone.
Les notes sont stockées dans le Google Sheet **JURY_ASSESSMENT** via un script Apps Script.

- `index.html` : la page, un seul fichier autonome, servie par **GitHub Pages**.
- `Code.gs` : le serveur Google Apps Script, lié au tableur et déployé avec `clasp`.
- `appsscript.json` : le manifeste ; il fixe déjà « Exécuter en tant que : moi » et « Qui a accès : tout le monde ».

## Mise en route

Le script est **lié** au tableur JURY_ASSESSMENT (Extensions → Apps Script) et se déploie en ligne de commande :

```bash
clasp push                                 # envoie Code.gs, index.html, appsscript.json
clasp update-deployment <deploymentId>     # nouvelle version ; l'URL /exec ne change pas
```

`.clasp.json` n'est pas versionné, il contient les ID du script et du tableur. Le recréer avec
`clasp create-script --parentId <id du tableur>`, ou le demander à l'équipe.

### Pourquoi la page n'est pas servie par Apps Script

`doGet()` sait servir `index.html` lui-même, ce qui est pratique pour tester, mais une page HTML servie
par Apps Script passe par le routage Drive : il échoue avec **« Impossible d'ouvrir le fichier pour le
moment »** pour tout visiteur connecté à plusieurs comptes Google. Les jurés ouvrent donc la page sur
GitHub Pages, et seules les **données** viennent d'Apps Script via `fetch`, qui n'est pas concerné par ce
routage. Résultat : aucune connexion Google n'est nécessaire, ni pour ouvrir la page, ni pour noter.

`API_URL`, dans `index.html`, pointe sur l'URL `/exec` du déploiement. Quand c'est Apps Script qui sert
la page, `doGet()` réécrit cette ligne avec sa propre URL.

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
