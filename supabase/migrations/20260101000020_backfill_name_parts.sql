-- ============================================================================
-- HYT Wayfinder - backfill first_name / middle_initial / last_name
-- ============================================================================
--
-- Fills the three name columns from the registrar's name sheet, keyed on the
-- exact stored value of users.name. Generated against this database and
-- verified to match 131 roster rows (133 live rows, so a
-- duplicated account is filled in too).
--
-- IGNORES THE SHEET'S "MIDDLE NAME" COLUMN, as requested. Only first name,
-- middle initial and last name are written. The sheet's middle name is kept
-- nowhere: for most rows it is already inside users.name, and users.name is
-- left exactly as it is.
--
-- middle_initial is stored as a bare upper-case letter with no period, matching
-- lib/fullName.ts and the column comment in 20260101000019. The sheet's "O."
-- is written as 'O'.
--
-- Rows whose middle initial is "N/A" on the sheet get NULL, even where the
-- stored name happens to carry an initial. Two rows are in that position -
-- Dianne Sinner and Annalyn Narte - and their stored names read "Dianne C.
-- Sinner" and "Annalyn B. Narte". If the sheet is wrong, fix those two by hand.
--
-- Only touches the rows named below: users.name is the key, and a row whose
-- name is not in this list is left alone (self-registered accounts, test
-- accounts, and the extra duplicate rows that carry no middle initial).
--
-- Safe to re-run: it is a plain assignment from a fixed list.
-- ============================================================================

WITH roster(full_name, first_name, middle_initial, last_name) AS (
  VALUES
  ('Gemmalyn O. Aranda', 'Gemmalyn', 'O', 'Aranda'),
  ('Prince Jhazkhie A. Marquez', 'Prince Jhazkhie', 'A', 'Marquez'),
  ('Mary Grace M. Antalan', 'Mary Grace', 'M', 'Antalan'),
  ('Chryss Jericho N. Corsanes', 'Chryss Jericho', 'N', 'Corsanes'),
  ('Jeffrey A. Gardoce', 'Jeffrey', 'A', 'Gardoce'),
  ('Jhay Ilagan', 'Jhay', NULL, 'Ilagan'),
  ('Ana Mae S. Lucero', 'Ana Mae', 'S', 'Lucero'),
  ('Richard B. Sta. Romana', 'Richard', 'B', 'Sta. Romana'),
  ('Veronica M. Onelongo', 'Veronica', 'M', 'Onelongo'),
  ('Daniel M. Canes', 'Daniel', 'M', 'Canes'),
  ('Judah A. Puntual', 'Judah', 'A', 'Puntual'),
  ('Maui N. Santos', 'Maui', 'N', 'Santos'),
  ('Jasmine Chlouie S. Zuela', 'Jasmine Chlouie', 'S', 'Zuela'),
  ('Gabrielle T. Padilla', 'Gabrielle', 'T', 'Padilla'),
  ('Lance D. Casinto', 'Lance', 'D', 'Casinto'),
  ('Marca Angela L. Olog', 'Marca Angela', 'L', 'Olog'),
  ('Veronica A. Mapalad', 'Veronica', 'A', 'Mapalad'),
  ('Shaira Marie B. Borja', 'Shaira Marie', 'B', 'Borja'),
  ('Annie P. Bulalacao', 'Annie', 'P', 'Bulalacao'),
  ('John Carlo L. Maestre', 'John Carlo', 'L', 'Maestre'),
  ('Angelica Marie Quibin', 'Angelica Marie', NULL, 'Quibin'),
  ('Ma. Isabel P. Firmalino', 'Ma. Isabel', 'P', 'Firmalino'),
  ('Rodel C. Quijada', 'Rodel', 'C', 'Quijada'),
  ('Joancen R. Palo', 'Joancen', 'R', 'Palo'),
  ('Buenafe V. Escalera', 'Buenafe', 'V', 'Escalera'),
  ('Francis P. Tuazon', 'Francis', 'P', 'Tuazon'),
  ('May V. Evans', 'May', 'V', 'Evans'),
  ('Daniella Casiano', 'Daniella', NULL, 'Casiano'),
  ('John Lloyd Y. Carpio', 'John Lloyd', 'Y', 'Carpio'),
  ('Shanlege Nicole T. Artesano', 'Shanlege Nicole', 'T', 'Artesano'),
  ('Zyraclaire C. Fernandez', 'Zyraclaire', 'C', 'Fernandez'),
  ('Julia Mae T. Patso', 'Julia Mae', 'T', 'Patso'),
  ('Ruby Ann M. Mabato', 'Ruby Ann', 'M', 'Mabato'),
  ('Railey M. Carillo', 'Railey', 'M', 'Carillo'),
  ('Esrafil M. Samolden', 'Esrafil', 'M', 'Samolden'),
  ('Chevie Sheen Z. Ramos', 'Chevie Sheen', 'Z', 'Ramos'),
  ('Romel Jhon Nickelson C. Cruz', 'Romel Jhon Nickelson', 'C', 'Cruz'),
  ('Erwin D. Subalisid', 'Erwin', 'D', 'Subalisid'),
  ('Joshua Miguel Corpuz', 'Joshua Miguel', NULL, 'Corpuz'),
  ('Diana C. Cortez', 'Diana', 'C', 'Cortez'),
  ('Reinmah Iya T. Marmita', 'Reinmah Iya', 'T', 'Marmita'),
  ('Lester D. Perez', 'Lester', 'D', 'Perez'),
  ('Donnadel B. Molina', 'Donnadel', 'B', 'Molina'),
  ('Sheila A. Plotria', 'Sheila', 'A', 'Plotria'),
  ('Alyza Ann L. Ramirez', 'Alyza', 'L', 'Ramirez'),
  ('Cyrill D. Canete', 'Cyrill', 'D', 'Canete'),
  ('Kimberly Shine B. Reyes', 'Kimberly Shine', 'B', 'Reyes'),
  ('Stephanie O. Rojas', 'Stephanie', 'O', 'Rojas'),
  ('John Patrick S. Manozo', 'John', 'S', 'Manozo'),
  ('Jocelle D. Simon', 'Jocelle', 'D', 'Simon'),
  ('Ciauel L. Hernandez', 'Ciauel', 'L', 'Hernandez'),
  ('Chrizelle Kelly Geronimo', 'Chrizelle Kelly', NULL, 'Geronimo'),
  ('Quincie Jell D. Derueda', 'Quincie Jell', 'D', 'Derueda'),
  ('Carmina G. Mercado', 'Carmina', 'G', 'Mercado'),
  ('Gaveriell Oro', 'Gaveriell', NULL, 'Oro'),
  ('Kyra Isabel C. Hernandez', 'Kyra Isabel', 'C', 'Hernandez'),
  ('Angel Ann O. Yebra', 'Angel', 'O', 'Yebra'),
  ('Kylle Justine B. Jamito', 'Kylle', 'B', 'Jamito'),
  ('Marites A. Ramos', 'Marites', 'A', 'Ramos'),
  ('Athena Karyle D. Uy', 'Athena Karyle', 'D', 'Uy'),
  ('Maria Michelle E. Bautista', 'Maria Michelle', 'E', 'Bautista'),
  ('Lourdes B. Barcelona', 'Lourdes', 'B', 'Barcelona'),
  ('Genrina P. Jadulco', 'Genrina', 'P', 'Jadulco'),
  ('Jemuel B. Bismonte', 'Jemuel', 'B', 'Bismonte'),
  ('Aldrin B. Barbin', 'Aldrin', 'B', 'Barbin'),
  ('Ma. Shangrila S. Nadal', 'Ma. Shangrila', 'S', 'Nadal'),
  ('Shine Mary C. Bantug', 'Shine', 'C', 'Bantug'),
  ('Jade Russel Y. Amargo', 'Jade', 'Y', 'Amargo'),
  ('Maria Michelle M. Prendol', 'Maria Michelle', 'M', 'Prendol'),
  ('Maria Flor D. Lanas', 'Maria Flor', 'D', 'Lanas'),
  ('Rodora B. Ocampo', 'Rodora', 'B', 'Ocampo'),
  ('Adryan S. Ocampo', 'Adryan', 'S', 'Ocampo'),
  ('Rosanna V. Daban', 'Rosanna', 'V', 'Daban'),
  ('Anghellina P. Tuazon', 'Anghellina', 'P', 'Tuazon'),
  ('Judy Ann D. Latorre', 'Judy Ann', 'D', 'Latorre'),
  ('Jannet M. Pepe', 'Jannet', 'M', 'Pepe'),
  ('Abbigayle O. Abuda', 'Abbigayle', 'O', 'Abuda'),
  ('Ginalyn C. Galvez', 'Ginalyn', 'C', 'Galvez'),
  ('Marialyn P. Tuazon', 'Marialyn', 'P', 'Tuazon'),
  ('Kelvin D. Rublica', 'Kelvin', 'D', 'Rublica'),
  ('Maria Carmen T. Mariot', 'Maria Carmen', 'T', 'Mariot'),
  ('Amelia R. Dela Cruz', 'Amelia', 'R', 'Dela Cruz'),
  ('Julan Rowaya', 'Julan', NULL, 'Rowaya'),
  ('Joyce Mar A. Valenciado', 'Joyce Mar', 'A', 'Valenciado'),
  ('Joses Kyle Lalic', 'Joses Kyle', NULL, 'Lalic'),
  ('Nicko S. Dacayo', 'Nicko', 'S', 'Dacayo'),
  ('Edmond O. Aranda', 'Edmond', 'O', 'Aranda'),
  ('Lourdes L. Doria', 'Lourdes', 'L', 'Doria'),
  ('Joel D. Macapagal', 'Joel', 'D', 'Macapagal'),
  ('Bea Marie T. Gutierrez', 'Bea Marie', 'T', 'Gutierrez'),
  ('Lyra G. Estrella', 'Lyra', 'G', 'Estrella'),
  ('Jomer Boy E. Cano', 'Jomer Boy', 'E', 'Cano'),
  ('James Hooper E. Cano', 'James Hooper', 'E', 'Cano'),
  ('Brian Griffin R. Palo', 'Brian Griffin', 'R', 'Palo'),
  ('Rhica Shaira J. Longasa', 'Rhica Shaira', 'J', 'Longasa'),
  ('Cielo D. Lim', 'Cielo', 'D', 'Lim'),
  ('Riana Jean D. Marasigan', 'Riana Jean', 'D', 'Marasigan'),
  ('Vea Rafhaela B. Teniente', 'Vea Rafhaela', 'B', 'Teniente'),
  ('Reina Mae P. Recoco', 'Reina Mae', 'P', 'Recoco'),
  ('Mary Joy M. Daisog', 'Mary Joy', 'M', 'Daisog'),
  ('Ma. Cleotelde N. Labuntog', 'Ma. Cleotelde', 'N', 'Labuntog'),
  ('Krishea Mae D. Lotero', 'Krishea', 'D', 'Lotero'),
  ('Vanessa Mae N. Labuntog', 'Vanessa', 'N', 'Labuntog'),
  ('Nicole Magabulo', 'Nicole', NULL, 'Magabulo'),
  ('Loida B. Requiroso', 'Loida', 'B', 'Requiroso'),
  ('Blessie E. Aquino', 'Blessie', 'E', 'Aquino'),
  ('Jonalie P. Navarro', 'Jonalie', 'P', 'Navarro'),
  ('Patrick Infestan', 'Patrick', NULL, 'Infestan'),
  ('Dianne C. Sinner', 'Dianne', NULL, 'Sinner'),
  ('Annalyn B. Narte', 'Annalyn', NULL, 'Narte'),
  ('Ivy N. Tizon', 'Ivy', 'N', 'Tizon'),
  ('Jhelene Clyde M. Custodio', 'Jhelene', 'M', 'Custodio'),
  ('Rendelyn B. Sulla', 'Rendelyn', 'B', 'Sulla'),
  ('Elgine Galang', 'Elgine', NULL, 'Galang'),
  ('Lyndie A. Janito', 'Lyndie', 'A', 'Janito'),
  ('Mark R. Carmona', 'Mark', 'R', 'Carmona'),
  ('Ronald Binamira', 'Ronald', NULL, 'Binamira'),
  ('Cecillia P. Garcia', 'Cecillia', 'P', 'Garcia'),
  ('Henrietta M. Dollaga', 'Henrietta', 'M', 'Dollaga'),
  ('Ailene L. Dollaga', 'Ailene', 'L', 'Dollaga'),
  ('Jane G. Yu', 'Jane', 'G', 'Yu'),
  ('Jose Romel D. Pamana', 'Jose Romel', 'D', 'Pamana'),
  ('Marjorie A. Dela Cruz', 'Marjorie', 'A', 'Dela Cruz'),
  ('Honey Beth J. Bajada', 'Honey Beth', 'J', 'Bajada'),
  ('Ma. Alexa A. Guerrero', 'Ma. Alexa', 'A', 'Guerrero'),
  ('Sharon B. Rojas', 'Sharon', 'B', 'Rojas'),
  ('Erjielyn C. Dadis', 'Erjielyn', 'C', 'Dadis'),
  ('Alma C. Lorenzana', 'Alma', 'C', 'Lorenzana'),
  ('Rissa A. Oblipias', 'Rissa', 'A', 'Oblipias'),
  ('Erwin D. Fernandez', 'Erwin', 'D', 'Fernandez'),
  ('Mario P. Pamintuan', 'Mario', 'P', 'Pamintuan')
)
UPDATE public.users u
SET
  first_name     = r.first_name,
  middle_initial = r.middle_initial,
  last_name      = r.last_name
FROM roster r
WHERE u.name = r.full_name;


-- ============================================================================
-- Verify - run these after applying
-- ============================================================================

-- 1. Rows still missing a first or last name. Expect the test accounts and any
--    duplicate rows that are not on the sheet - nothing from the sheet.
SELECT name, first_name, middle_initial, last_name
FROM public.users
WHERE first_name IS NULL OR last_name IS NULL
ORDER BY name;

-- 2. The count that were filled. Expect 133.
SELECT count(*) AS filled
FROM public.users
WHERE first_name IS NOT NULL AND last_name IS NOT NULL;

-- 3. Spot-check.
SELECT name, first_name, middle_initial, last_name
FROM public.users
WHERE last_name IS NOT NULL
ORDER BY last_name, first_name
LIMIT 30;
