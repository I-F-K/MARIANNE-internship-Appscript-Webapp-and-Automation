# MARIANNE — Documentation fonctionnelle
### Automatisation du placement en alternance (BTS MCO / NDRC)

---

## 1. Contexte et objectifs

Le projet MARIANNE automatise le suivi des étudiants en BTS alternance (MCO / NDRC), depuis leur préinscription jusqu'à la signature de leur CERFA, en remplaçant un ensemble de tâches manuelles auparavant réparties entre plusieurs collaborateurs et plusieurs fichiers.

**Situation avant la mise en place de l'outil :**

- Aucune organisation centralisée : chaque collaborateur conservait ses propres informations sur son poste, sans partage.
- Manque de traçabilité : impossible de savoir qui avait traité quel dossier, ce qui rendait très difficile la reprise du travail en cas d'absence.
- Processus longs et lents, en particulier le "matching" étudiant/entreprise (le "setting"), fait manuellement CV par CV.
- Des étudiants oubliés une fois leur charte signée : rien n'imposait de les intégrer formellement au suivi.
- Suivi des CERFA laborieux, sans visibilité sur l'avancement des dossiers.

**Réponse apportée :** une base de données centralisée (Google Sheets), des automatisations Google Apps Script pour fiabiliser les statuts et synchronisations, et une web app dédiée au matching étudiant/entreprise et au placement.

---

## 2. Le parcours étudiant (processus métier)

1. **Signature de la charte** → préinscription de l'étudiant, lors d'un rendez-vous individuel (one-to-one).
2. **Workshop** → révision du CV et préparation aux entretiens d'embauche (one-to-one).
3. **Recherche d'alternance** → l'étudiant est présenté à des entreprises, passe des entretiens.
4. **Signature du CERFA** → si l'étudiant est retenu, signature du document administratif qui officialise son alternance.

---

## 3. Architecture générale

Le système repose sur trois briques qui communiquent entre elles :

| Brique | Rôle |
|---|---|
| **Google Sheets "PREINSCRITS 26/27"** | Base de données centrale de tous les étudiants |
| **Google Sheets "AGENDA" + Google Calendar** | Planification et suivi des entretiens en entreprise |
| **Web App (Apps Script)** | Matching IA candidats/entreprises et placement en entretiens |

Ces trois briques sont reliées par des scripts Google Apps Script qui tournent automatiquement (déclencheurs sur modification de cellule, ou sur horaire) pour garder toutes les données synchronisées, sans ressaisie manuelle.

---

## 4. La base centrale : feuille "PREINSCRITS 26/27"

C'est la fiche de référence de chaque étudiant : informations personnelles, informations des parents, promotion (MCO/NDRC), lien vers le CV, commentaires des collaborateurs ayant eu des entretiens avec l'étudiant, historique des entretiens passés, et statut d'avancement du CERFA.

Plusieurs automatisations viennent enrichir ou nettoyer cette feuille automatiquement :

### 4.1 Historique des entretiens (`suivi entretiens.js`)
Relit automatiquement tous les entretiens programmés dans la feuille AGENDA, les associe au bon étudiant (par nom/prénom normalisé) et vient remplir, dans l'ordre chronologique, les colonnes d'historique de la fiche PREINSCRITS (entreprise, lieu, date, statut). Une fonction de première initialisation permet de repartir de l'historique déjà existant dans AGENDA.

### 4.2 Liste noire visuelle (`Blacklist.js`)
Surveille l'historique des entretiens d'un étudiant : si trop de "refusé" (3 ou plus) ou trop de "pas venu" (2 ou plus) s'accumulent, la ligne entière de l'étudiant est colorée en noir (fond noir, texte blanc) pour signaler visuellement qu'il faut faire attention avant de le repositionner sur un entretien.

### 4.3 Tri alphabétique (`Tri alphabétique.js`)
Fonction de confort qui trie la feuille PREINSCRITS par ordre alphabétique (colonne Nom).

---

## 5. Suivi des CERFA (`archivage CERFA.js`)

Avant l'outil, le suivi des CERFA n'avait aucune structure. Ce script automatise entièrement la remontée des dossiers à traiter :

- Chaque étudiant a un statut CERFA : **vide**, **à faire** ou **fait**.
- Dès que le statut passe de "vide" à "à faire" ou "fait", la ligne change de couleur (repère visuel) et est automatiquement copiée dans une feuille dédiée, **"Gestion CERFA"**, consultée par l'équipe en charge des signatures.
- La synchronisation fonctionne dans les deux sens : une modification faite côté "Gestion CERFA" (par l'équipe signature) est reportée automatiquement dans PREINSCRITS.
- Le script gère aussi les cas de doublons (si un même étudiant se retrouve sur plusieurs lignes côté "Gestion CERFA", il fusionne intelligemment en gardant la ligne la plus complète) et attribue un identifiant unique à chaque étudiant pour fiabiliser les correspondances.

Ainsi, l'équipe CERFA n'a plus besoin de parcourir toute la base à la recherche des dossiers à traiter : seuls les dossiers concernés apparaissent dans leur feuille dédiée.

---

## 6. Gestion des entretiens : feuille "AGENDA" ↔ Google Calendar (`création agenda.js`)

Chaque ligne de la feuille AGENDA représente une entreprise, avec ses informations générales (contact, lieu, nombre de postes recherchés...) suivies d'une série de blocs de 3 colonnes (**étudiant / créneau / statut**), un bloc par entretien possible.

- Dès qu'un bloc est rempli (étudiant + date/heure), un événement est automatiquement créé dans le Google Agenda commun.
- La couleur de l'événement (et du bloc dans le Sheet) reflète l'état de l'entretien :
  - un créneau réservé sans nom d'étudiant → gris (à pourvoir) ;
  - un étudiant positionné mais sans statut → couleur neutre (en attente de retour) ;
  - un statut renseigné (Accepté / En attente / Refusé / Pas venu / Absence justifiée) → couleur dédiée, identique côté Sheet et côté Calendar.
- Un indicateur automatique (colonnes G/H) affiche en direct le nombre de candidats acceptés par rapport au nombre de postes recherchés, et colore la ligne en vert quand l'entreprise a tous ses postes pourvus par les étudiants de l'école.
- Une vérification périodique (toutes les 30 min) détecte si quelqu'un a changé la couleur d'un événement directement dans Google Calendar, et reporte ce changement dans le Sheet — sauf si la feuille a, entre-temps, été modifiée manuellement, auquel cas c'est toujours la feuille qui fait foi.
- Un script complémentaire (`nettoyage doublons calendrier.js`) nettoie périodiquement les références à des événements qui auraient été supprimés manuellement dans Google Calendar, pour éviter les erreurs de synchronisation.

Chaque modification dans AGENDA déclenche aussi automatiquement la mise à jour de l'historique des entretiens dans PREINSCRITS (voir §4.1).

## 7. La Web App — matching et placement

Pensée pour remplacer la recherche manuelle de profils (CV lus un par un, comparaison des compétences et de la distance à la main), la web app propose un classement automatique des meilleurs candidats pour chaque entreprise.

### 7.1 Analyse IA des CV
Chaque CV est analysé (via l'API Mistral) pour en extraire : un résumé, les expériences et secteurs, les qualités, les centres d'intérêt, les compétences opérationnelles, et la présence d'un permis de conduire. Une note IA sur 25 ("score retail") est attribuée. Chaque analyse est mise en cache (elle n'est jamais refaite tant que le CV ou la version du prompt ne change pas).

### 7.2 Analyse IA des entreprises
De la même façon, chaque entreprise est analysée : secteur d'activité, postes envisageables pour un profil BTS MCO/NDRC, et exigences explicites reprises des commentaires du placeur (jamais inventées si l'entreprise n'est pas identifiée avec certitude).

### 7.3 Score de compatibilité sur 100
Chaque candidat reçoit, pour chaque entreprise, un score composé de quatre éléments :

| Composante | Poids | Origine |
|---|---|---|
| Note pédagogique interne | 35 pts | Note attribuée par l'équipe (fusée, bon profil, plaçable, potentiel à travailler, cave) |
| Analyse IA du CV ("retail") | 20 pts | Score /25 du CV, ramené sur 20 |
| Trajet réel | 30 pts | Temps de trajet réel domicile → entreprise (transports Île-de-France Mobilités) |
| Affinité candidat/entreprise | 15 pts | Recoupement entre les mots-clés du CV et ceux de l'entreprise |

Un malus est appliqué si l'étudiant a déjà un autre entretien prévu dans les 2 heures autour du créneau visé, afin de toujours privilégier un candidat totalement disponible.

### 7.4 Sélection et placement
La web app affiche, pour chaque créneau d'entreprise à pourvoir, les 10 meilleurs candidats théoriques avec leur numéro de téléphone, leur historique d'entretiens et des actions rapides (non disponible, refus du candidat, etc.), qui viennent directement mettre à jour le Google Sheet.

Lorsqu'un étudiant est placé sur un créneau :
- le Google Sheet (AGENDA) est mis à jour automatiquement ;
- un mail de confirmation est envoyé à l'étudiant avec les informations de l'entretien et, si disponible, la fiche de poste correspondante fournie par un collaborateur.

### 7.5 Les onglets de la web app

| Onglet | Contenu |
|---|---|
| **Carte** | Vue principale : entreprises, créneaux à pourvoir, classement des candidats |
| **Entretiens** | Historique des entretiens de tous les étudiants, avec possibilité de statuer directement depuis la web app |
| **Historique** | Journal des actions effectuées dans la web app (qui a placé qui, qui a modifié quel statut) — répond directement au problème initial de traçabilité |
| **Analyses IA** | Historique des analyses de CV (notes /25, résumés, alertes) |
| **Données** | Contrôle des données manquantes ou erronées dans le Google Sheets. Tant qu'une anomalie n'est pas corrigée dans le Sheet, l'application le signale plutôt que de calculer un résultat peu fiable |

---

## 8. Ce que l'outil a résolu

| Problème initial | Réponse apportée |
|---|---|
| Aucune centralisation des informations | Base unique PREINSCRITS 26/27 + AGENDA, partagées et synchronisées |
| Pas de traçabilité de qui a fait quoi | Onglet "Historique" de la web app + identifiants uniques + historique d'entretiens |
| Process de matching manuel et lent | Scoring IA automatique sur 100 + calcul de l'itinéraire en transports + sélection des 10 meilleurs candidats |
| Étudiants oubliés après signature de charte | Intégration systématique au dashboard dès la signature |
| Suivi CERFA anarchique | Feuille "Gestion CERFA" alimentée automatiquement selon le statut |

---

## 9. Éléments de configuration nécessaires

- **Clé API Mistral** — pour les analyses IA de CV et d'entreprises.
- **Clé API PRIM** (Île-de-France Mobilités) — pour le calcul des itinéraires réels en transport.
- **Déploiement de la web app** en tant qu'application web depuis l'éditeur Apps Script.
- Un compte Google Calendar qui servira d'agenda commun et sera propriétaire du déclencheur pour l'automatisation de l'agenda.

---

## 10. Points de vigilance connus

- La synchronisation Agenda → Sheets (changement de couleur manuel dans Google Calendar) fonctionne par vérification périodique (toutes les 30 min), et non en temps réel : Google Calendar ne déclenche aucun événement natif sur un changement de couleur.
- Les analyses IA (CV et entreprises) sont mises en cache et ne sont recalculées que si le contenu change ou si la version du prompt est explicitement incrémentée (pour éviter de payer/relancer des appels IA inutiles).
- La fiabilité du scoring dépend de la qualité des données saisies (ville renseignée, lien CV valide) : l'onglet "Données" sert justement à repérer ces cas avant qu'ils ne faussent silencieusement un classement.
