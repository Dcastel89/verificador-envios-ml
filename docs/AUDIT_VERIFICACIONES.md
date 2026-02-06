# Auditoría Exhaustiva de Verificaciones - verificador-envios-ml

**Fecha:** 2026-02-06
**Alcance:** Todos los mecanismos de verificación, validación, cruce de datos y uso de IA del sistema.

---

## 1. DIAGRAMA ASCII DE MÓDULOS Y CRUCES

```
                          ┌─────────────────────────────────────┐
                          │        FUENTES DE DATOS EXTERNAS     │
                          │  MercadoLibre API  │  Jumpseller API │
                          │  Google Sheets     │  Archivos JSON  │
                          └────────┬──────────────────┬──────────┘
                                   │                  │
                 ┌─────────────────▼──────────────────▼──────────────┐
                 │              CAPA DE INGESTA                       │
                 │                                                    │
                 │  [V1] Webhook ML ──► Validación topic/resource     │
                 │  [V2] Sync Morning ──► shouldProcessOrder()        │
                 │  [V3] Sync Manual  ──► shouldProcessOrder()        │
                 │  [V4] Jumpseller Sync ──► status filter            │
                 └────────┬───────────────────────┬──────────────────┘
                          │                       │
            ┌─────────────▼───────────┐  ┌───────▼────────────────┐
            │  FILTRADO DE ÓRDENES    │  │  FILTRADO MAYORISTA    │
            │                         │  │                        │
            │ [V5] shouldProcessOrder │  │ [V11] status=paid      │
            │   - logistic_type       │  │ [V12] unfulfilled      │
            │   - SLA date = TODAY    │  │ [V13] date range       │
            │   - delayed+ready       │  │                        │
            │ [V6] Dedup por ID       │  │ [V14] Dedup mayorista  │
            │ [V7] !fulfillment       │  │                        │
            │ [V8] !custom/not_spec   │  └───────┬────────────────┘
            │ [V9] status whitelist   │          │
            └────────┬────────────────┘          │
                     │                           │
        ┌────────────▼───────────────────────────▼──────────────┐
        │              GOOGLE SHEETS (persistencia)              │
        │  Envios_Lunes..Domingo  │  Mayorista_Pedidos/Items    │
        │  Barcodes │ Rotuladora  │  Errores_SKU │ Tokens       │
        └────────────┬───────────────────────────┬──────────────┘
                     │                           │
   ┌─────────────────▼─────────────┐  ┌─────────▼──────────────────┐
   │   VERIFICACIÓN ML (principal)  │  │   VERIFICACIÓN MAYORISTA    │
   │                                │  │                             │
   │  Operador abre envío en UI     │  │  Operador abre pedido       │
   │           │                    │  │           │                 │
   │           ▼                    │  │           ▼                 │
   │  Escanea producto (cámara)     │  │  Escanea producto (cámara)  │
   │           │                    │  │           │                 │
   │     ┌─────▼─────┐             │  │     ┌─────▼─────┐          │
   │     │ [V15]     │             │  │     │ [V20]     │          │
   │     │ Claude AI │◄──[IA]      │  │     │ Claude AI │◄──[IA]   │
   │     │ Vision    │             │  │     │ Vision    │          │
   │     └─────┬─────┘             │  │     └─────┬─────┘          │
   │           │                    │  │           │                 │
   │     ┌─────▼──────┐            │  │     ┌─────▼──────┐         │
   │     │ [V16]      │            │  │     │ [V21]      │         │
   │     │ Barcode    │            │  │     │ Score      │         │
   │     │ Lookup     │            │  │     │ Matching   │◄──[IA*] │
   │     └─────┬──────┘            │  │     └─────┬──────┘         │
   │           │                    │  │           │                 │
   │     ┌─────▼──────┐            │  │     ┌─────▼──────┐         │
   │     │ [V17]      │            │  │     │ [V22]      │         │
   │     │ SKU Match  │◄──[IA*]    │  │     │ Item-level │         │
   │     │ Suggestion │            │  │     │ Verificar  │         │
   │     └─────┬──────┘            │  │     └─────┬──────┘         │
   │           │                    │  │           │                 │
   │     ┌─────▼──────┐            │  │     ┌─────▼──────┐         │
   │     │ [V18]      │            │  │     │ [V23]      │         │
   │     │ markAs     │            │  │     │ checkOrder │         │
   │     │ Verified   │            │  │     │ Status     │         │
   │     └─────┬──────┘            │  │     └────────────┘         │
   │           │                    │  │                             │
   └───────────┼────────────────────┘  └─────────────────────────────┘
               │
   ┌───────────▼────────────────────┐
   │   POST-VERIFICACIÓN            │
   │                                │
   │  [V24] actualizarEstados       │
   │    (batch: ML API → Sheet)     │
   │  [V25] removeCancelled         │
   │  [V26] shouldClearOldRecords   │
   │  [V27] copiarHistorial         │
   │  [V28] saveSkuError            │
   │  [V29] Diagnóstico (10 pasos) │
   └────────────────────────────────┘

   [IA]  = Usa Claude Vision (LLM multimodal)
   [IA*] = Usa scoring/matching algorítmico (NO LLM, sí heurístico)
```

---

## 2. TABLA MAESTRA DE VERIFICACIONES

| # | Verificación | Input | Repositorio/Fuente | Output | Dependencias | IA |
|---|---|---|---|---|---|---|
| V1 | **Webhook ML - Validación de topic** | `notification.topic`, `notification.resource` | Payload HTTP de MercadoLibre | Continúa/descarta | Ninguna | No |
| V2 | **Webhook ML - Account matching** | `notification.user_id`, `sellerIdCache` | Cache en memoria + ML API `/users/me` | `account` object o descarte | V1 | No |
| V3 | **Webhook ML - Order status check** | `orderData.shipping`, `shipmentData.status` | ML API `/orders/:id`, `/shipments/:id` | Continúa si `ready_to_ship\|pending\|handling` | V1, V2 | No |
| V4 | **Webhook ML - Fulfillment filter** | `shipmentData.logistic_type` | ML API `/shipments/:id` | Descarta si `fulfillment` | V3 | No |
| V5 | **shouldProcessOrder** | `expectedDate`, `slaStatus`, `logisticType`, `shipmentStatus` | ML API `/shipments/:id/sla` | `true/false` | V3, V4 | No |
| V6 | **Deduplicación por shipmentId** | `shipmentId` | Google Sheets columna C | Skip si ya existe | V5 | No |
| V7 | **Custom/not_specified filter** | `shipmentData.mode` | ML API `/shipments/:id` | Descarta si `not_specified\|custom` | V3 | No |
| V8 | **isWorkingHours** | Hora actual (Argentina TZ) | Reloj del sistema | `true/false` (L-V 8:30-19:00) | Ninguna | No |
| V9 | **Pack/Carrito detection** | `orderData.pack_id` | ML API `/packs/:id` | Lista de `orderIds` agrupados | V3 | No |
| V10 | **Token validity** | `account.accessToken` | ML API (cualquier call) | Refresh automático en 401/403 | Ninguna | No |
| V11 | **Jumpseller status filter** | `order.status` | Jumpseller API `/orders` | Solo `paid` | Ninguna | No |
| V12 | **Jumpseller fulfillment filter** | `order.fulfillment_status` | Jumpseller API `/orders` | Solo `unfulfilled` | V11 | No |
| V13 | **Jumpseller date range** | `order.created_at` | Jumpseller API | Últimas 2 semanas | V11 | No |
| V14 | **Dedup mayorista** | `orderId` | Google Sheets Mayorista | Skip si ya existe | V11-V13 | No |
| **V15** | **Claude Vision Analysis** | **Imagen(es) base64 + productoEsperado (SKU+desc)** | **Anthropic API `claude-sonnet-4-20250514`** | **JSON: correcto, modelo, color, código, confianza** | **Ninguna** | **Sí** |
| V16 | **Barcode Lookup** | `codigoRotuladora` (7 dígitos) | Cache en memoria (`barcodeCache`) ← Sheets Barcodes + Rotuladora + `codigos_fabrica.json` | `skuVinculado` o null | V15 (código extraído por Claude) | No |
| **V17** | **SKU Suggestion Scoring** | **`modeloDetectado`, `textoEncontrado`, `tipoProducto`** | **`prompts/config.json` → `skuRules`** | **Top 3 SKUs sugeridos con score** | **V15 (datos extraídos por Claude)** | **Parcial** |
| V18 | **markAsVerified** | `shipmentId`, `items[]`, `verificacionDetalle`, `isParcial` | Google Sheets (hoja del día) | Estado: `Verificado` / `Parcial (X%)` + método | V15 o verificación manual | No |
| V19 | **Product type detection** | `sku`, `descripcion` | `prompts/config.json` → `tipos` (prefijos + palabrasClave) | `{nombre, config}` del tipo | Ninguna | No |
| **V20** | **Claude Vision Mayorista** | **Imagen(es) base64 (sin producto esperado = modo extracción)** | **Anthropic API `claude-sonnet-4-20250514`** | **JSON: texto, modelo, color, tipo, confianza** | **Ninguna** | **Sí** |
| **V21** | **Score Matching Mayorista (client-side)** | **`modeloDetectado`, `colorDetectado`, `tipoProducto` + lista de items del pedido** | **Items del pedido (en memoria del navegador)** | **Auto-match si score >= 30** | **V20** | **Parcial** |
| V22 | **updateItemVerification** | `orderId`, `sku`, `verificados`, `metodo` | Google Sheets `Mayorista_Items` | Item marcado + trigger checkOrder | V20/V21 o manual | No |
| V23 | **checkAndUpdateOrderStatus** | `orderId` | Google Sheets `Mayorista_Items` (todos los items) | Marca orden `Verificado` si ALL items.verificados >= items.cantidad | V22 | No |
| V24 | **actualizarEstadosEnvios** | Todos los envíos pending en Sheet | ML API `/shipments/:id` por cada uno | Estado actualizado: Despachado/Entregado/Eliminado | V18 (solo toca no-verificados) | No |
| V25 | **removeCancelledShipments** | Cada envío pending en Sheet | ML API `/shipments/:id` | Elimina fila si `cancelled` | Ninguna | No |
| V26 | **shouldClearOldRecords** | Columna K (Promesa) de la hoja | Google Sheets | `true/false` si hay registros viejos | Ninguna | No |
| V27 | **copiarHistorial** | Hoja del día completa | Google Sheets → History Sheet | Copia y limpia | Cron 19:00 | No |
| V28 | **saveSkuError** | `sku`, `descripcion`, `nota`, `envioId`, `cuenta`, `itemId` | Google Sheets `Errores_SKU` | Fila de error registrada | Decisión del operador | No |
| V29 | **Diagnóstico (10 pasos)** | `orderId` | ML API (orden, envío, SLA) + Google Sheets | Checklist paso a paso con `ok/motivo` | Combina V3-V7 en modo read-only | No |
| V30 | **Config Description (Claude)** | Imagen(es) + SKU opcional | Anthropic API | JSON con reglas de verificación generadas | Ninguna | **Sí** |
| V31 | **Auth session check** | `session_token` (cookie/header) | Cache en memoria `sessions{}` | Autenticado/no autenticado (TTL 24h) | Ninguna | No |

---

## 3. DETALLE DE CADA VERIFICACIÓN

### V1: Webhook ML - Validación de topic
- **Archivo:** `server.js:2156`
- **Objetivo:** Filtrar notificaciones que no sean de órdenes.
- **Input:** `notification.topic` del payload POST de MercadoLibre.
- **Dónde corre:** Servidor, endpoint `POST /webhooks/ml`.
- **Output:** Continúa el procesamiento o retorna silenciosamente.
- **Criterio:** `topic === 'orders_v2' || topic === 'orders'` → pasa. Cualquier otro → descartado.
- **Errores típicos:** Ninguno conocido. ML puede enviar topics como `shipments`, `payments`, etc.

### V2: Webhook ML - Account matching
- **Archivo:** `server.js:2178-2210`
- **Objetivo:** Determinar a qué cuenta ML pertenece la notificación.
- **Input:** `notification.user_id`.
- **Dónde corre:** Servidor.
- **Output:** Objeto `account` con credenciales, o descarte si no se encuentra.
- **Criterio:** Busca en `sellerIdCache` (hash en memoria). Si no existe, itera cuentas llamando a `/users/me` para cada una hasta encontrar match.
- **Falsos negativos:** Si el token de una cuenta está expirado y no se puede renovar, esa cuenta no será evaluada.

### V3: Webhook ML - Order/Shipment status
- **Archivo:** `server.js:2215-2260`
- **Objetivo:** Verificar que la orden tenga envío válido y estado procesable.
- **Input:** `orderData.shipping.id`, `shipmentData.status`.
- **Dónde corre:** Servidor.
- **Criterio:** Requiere `shipping.id` presente. Status debe ser `ready_to_ship`, `pending`, o `handling`.
- **Falsos negativos:** Órdenes con status `paid` pero sin shipping.id (raro, pero posible en acordar con comprador).

### V5: shouldProcessOrder (FILTRO CENTRAL)
- **Archivo:** `server.js:363-397`
- **Objetivo:** Determinar si un envío debe aparecer en el panel del día.
- **Input:** `expectedDate` (ISO del SLA), `slaStatus`, `logisticType`, `shipmentStatus`.
- **Dónde corre:** Servidor. Usado en: webhook handler, sync morning, sync manual, diagnóstico.
- **Output:** `true/false`.
- **Criterios (OR):**
  1. `logisticType` in `['self_service', 'xd_drop_off', 'cross_docking']` (excluyente si no cumple)
  2. `slaStatus === 'delayed' AND shipmentStatus === 'ready_to_ship'` → `true`
  3. `expectedDate.split('T')[0] === todayStr` (fecha SLA = hoy) → `true`
- **Falsos negativos:** Envíos con promesa de mañana que llegan tarde (no se ven hasta el día de su promesa). Envíos delayed que ya no están en `ready_to_ship` (ej: `handling`).
- **Falsos positivos:** Ninguno conocido; el filtro es conservador.

### V6: Deduplicación por shipmentId
- **Archivo:** `server.js:2239-2246`
- **Objetivo:** Evitar agregar el mismo envío dos veces a la hoja del día.
- **Input:** `shipmentId` string.
- **Dónde corre:** Servidor.
- **Criterio:** Busca `shipmentId` en columna C de la hoja del día. Si existe → skip.
- **Riesgo:** Race condition si dos webhooks llegan simultáneamente. No hay lock distribuido. Mitigado parcialmente con `getExistingShipmentIds()` que lee antes de escribir.

### V10: Token validity / Auto-refresh
- **Archivo:** `server.js:399-431`
- **Objetivo:** Mantener tokens ML válidos sin intervención manual.
- **Input:** Respuesta HTTP de ML API.
- **Dónde corre:** Servidor, en `mlApiRequest()` wrapper.
- **Criterio:** Si la respuesta es 401/403 → intenta refresh. Si el refresh falla → retorna `null`.
- **Errores típicos:** Refresh token también expirado (requiere re-auth manual via OAuth flow).

---

### V15: Claude Vision Analysis (VERIFICACIÓN CON IA - PRINCIPAL)
- **Archivo:** `server.js:1730-1878`, prompts en `prompts.js:129-245` (verification) y `prompts.js:248-303` (extraction).
- **Objetivo:** Analizar fotos de productos para determinar si coinciden con el pedido.
- **Detalle completo en Sección 4 (Énfasis IA).**

### V16: Barcode Lookup
- **Archivo:** `barcodes.js:217-240`, invocado en `server.js:1809-1812`.
- **Objetivo:** Vincular código de rotuladora (7 dígitos) detectado por Claude con un SKU conocido.
- **Input:** `result.codigoRotuladora` (string de 7 dígitos extraído por Claude de la imagen).
- **Dónde corre:** Servidor.
- **Repositorio:** Cache en memoria `barcodeCache{}` (~1500 entradas), alimentado por:
  - Google Sheets pestaña `Barcodes` (columnas A:C)
  - Google Sheets pestaña `Rotuladora` (columnas A:B)
  - Archivo local `codigos_fabrica.json` (~500 entradas, prioridad máxima)
- **Output:** `skuVinculado` (string SKU) o `null`.
- **Criterio:** Búsqueda exacta en hash (`barcodeCache[barcode]`). Fallbacks: si 13 dígitos y empieza con 0, prueba sin cero; si 12 dígitos, prueba con cero al inicio (EAN-13 padding).
- **Errores típicos:** Claude puede leer mal un dígito del código (ej: "0" vs "O", "1" vs "7"). El cache puede estar desactualizado si se agregan códigos en Sheets pero no se hace reload.

### V17: SKU Suggestion Scoring
- **Archivo:** `server.js:1814-1867`
- **Objetivo:** Cuando no hay `skuVinculado` (barcode no encontrado), sugerir SKUs probables.
- **Input:** `modeloDetectado`, `textoEncontrado`, `tipoProducto` (todos extraídos por Claude en V15).
- **Dónde corre:** Servidor.
- **Repositorio:** `prompts/config.json` → `skuRules` (12+ reglas específicas).
- **Output:** Array `skusSugeridos` con máximo 3 SKUs ordenados por score.
- **Algoritmo de scoring:**
  - Por cada SKU en `skuRules`:
    - `modelo` encontrado en `formatoModelo` → +3 pts
    - `modelo` encontrado en `dondeVerificar` → +2 pts
    - `modelo` encontrado en `nota` → +1 pt
    - Si score=0 y hay `texto`: palabras del texto (>3 chars) encontradas en `nota`/`dondeVerificar` → +1 pt por match (mínimo 2 matches para contar)
  - Sort descendente por score, top 3.
- **Criterio de "match":** Score > 0. No hay umbral mínimo explícito.
- **Falsos positivos:** Palabras genéricas ("wireless", "smart") pueden matchear múltiples reglas. Modelo "A25" puede matchear si alguna nota menciona "A25" colateralmente.
- **Es IA:** Parcial. Es algorítmico (substring matching con pesos), no usa LLM. Pero depende de datos extraídos por Claude (V15).

### V18: markAsVerified
- **Archivo:** `server.js:982-1077`
- **Objetivo:** Registrar resultado de verificación en Google Sheets.
- **Input:** `shipmentId`, `items[]` (array de SKUs), `verificacionDetalle[]` ({sku, quantity, scanned, manual}), `isParcial`.
- **Dónde corre:** Servidor, endpoint `POST /api/shipment/:id/verificado`.
- **Output:** Fila actualizada en Sheet con:
  - **Columna F (SKUs):** Ej: `"SCRI17 OK, SCLI17 (2/3), SCNI17 FALTA"`
  - **Columna G (Estado):** `"Verificado"` o `"Parcial (73%)"`
  - **Columna H (HoraVerif):** Timestamp Argentina
  - **Columna I (Método):** `"Escaneado (3)"`, `"Manual (2)"`, `"Mixto (Esc:2 Man:1)"`
- **Criterio:** Full verificación = `isParcial === false`. Porcentaje = `(totalScanned + totalManual) / totalRequired * 100`.

### V19: Product Type Detection
- **Archivo:** `prompts.js:72-108`
- **Objetivo:** Clasificar producto por tipo para aplicar reglas de verificación específicas.
- **Input:** `sku` (string), `descripcion` (string).
- **Dónde corre:** Servidor.
- **Algoritmo (2 tiers):**
  1. **Por prefijo SKU** (más confiable): `sku.toUpperCase().startsWith(prefijo)`. Ej: `SC*` → funda-silicona, `SMT*` → smartband.
  2. **Por palabras clave** en descripción: `descripcion.toLowerCase().indexOf(keyword)`. Ej: "auricular" → auriculares.
  3. **Fallback:** tipo `generico`.
- **Output:** `{nombre: 'funda-silicona', config: {fotosMaximas: 1, dondeVerificar: '...', ...}}`.
- **13 tipos:** funda-silicona, funda-transparente, vidrio, funda-anillo, smartband, auriculares, cargador, cable, adultos, reloj + genérico.

### V21: Score Matching Mayorista (CLIENT-SIDE)
- **Archivo:** `public/mayorista/index.html:1934-2024` (JavaScript en navegador)
- **Objetivo:** Automáticamente emparejar producto detectado por Claude con ítem correcto del pedido mayorista.
- **Input:** `modeloDetectado`, `colorDetectado`, `tipoProducto` (de V20) + lista de items del pedido (nombre, SKU, cantidad).
- **Dónde corre:** **Navegador del operador** (client-side JavaScript).
- **Algoritmo de scoring (por cada item del pedido):**
  - Modelo exacto en nombre: +50 pts
  - Modelo exacto en SKU: +50 pts
  - Cada palabra del modelo (>2 chars) en nombre: +10 pts
  - Cada palabra del modelo (>2 chars) en SKU: +10 pts
  - Color en nombre: +20 pts
  - Color en SKU: +15 pts
  - Tipo producto matches categoría: +30 pts (mapeo: FUNDA→funda, VIDRIO→vidrio, etc.)
- **Umbral:** Score >= 30 para auto-match.
- **Output:** Auto-selección del item y marcado como verificado si supera umbral.
- **Falsos positivos:** Modelo "A25" aparece en nombre Y SKU de varios items → puede elegir el equivocado. Color genérico "Negro" matchea demasiado.

### V23: checkAndUpdateOrderStatus (Mayorista)
- **Archivo:** `jumpseller.js:602-628`
- **Objetivo:** Determinar si TODA la orden mayorista está verificada.
- **Input:** Todos los items de la orden desde Sheet.
- **Criterio:** `items[i].verificados >= items[i].cantidad` para TODOS los items.
- **Output:** Si todos cumplen → `markOrderVerified()` con estado "Verificado".

### V24: actualizarEstadosEnvios
- **Archivo:** `server.js:1965-2021`
- **Objetivo:** Actualización batch de estados desde ML API.
- **Input:** Todas las filas pending de la hoja del día.
- **Dónde corre:** Servidor (cron o manual).
- **Skip:** Si estado actual es `Verificado`, `Despachado`, o `Entregado`.
- **Transiciones:** `cancelled` → eliminar fila. `shipped` → "Despachado". `delivered` → "Entregado".
- **Throttle:** 50ms delay entre cada call a ML API.

### V29: Diagnóstico (10 pasos)
- **Archivo:** `server.js:2690-2825`
- **Objetivo:** Troubleshooting de por qué una orden no aparece.
- **Input:** `orderId`.
- **Dónde corre:** Servidor, endpoint `GET /api/diagnostico/:orderId`.
- **Pipeline de 10 pasos:**
  1. Buscar orden en todas las cuentas ML
  2. Validar `status === 'paid'`
  3. Validar `shipping.id` existe
  4. Obtener datos del envío
  5. Validar `status !== 'cancelled'`
  6. Validar `logistic_type !== 'fulfillment'`
  7. Validar `mode !== 'not_specified|custom'`
  8. Obtener SLA y comparar fecha
  9. Validar `logistic_type` en whitelist
  10. Ejecutar `shouldProcessOrder()` y verificar existencia en Sheet
- **Output:** Array de `{paso, ok, motivo}` + conclusión.

---

## 4. ÉNFASIS: BÚSQUEDA CON IA - DESGLOSE PROFUNDO

El sistema tiene **3 usos de IA** (todos basados en Claude Vision) y **2 algoritmos heurísticos** que dependen de la salida de la IA.

---

### 4.A: USO DE IA #1 - Verificación de Producto (V15)

#### A. Dónde aplica
- **Pantalla:** Interfaz principal de verificación (`public/index.html`).
- **Flow:** Operador selecciona envío → ve lista de productos → escanea cada producto con cámara → envía foto(s) al servidor.
- **Endpoint:** `POST /api/vision/analyze` con `producto` (SKU+descripción del pedido).
- **Disparador:** Manual. El operador captura la foto y presiona "Verificar".
- **Condición:** `productoEsperado` está presente (hay un producto del pedido seleccionado).

#### B. Qué hace exactamente
- **Función:** Es **verificación visual multimodal** (no búsqueda semántica, no clasificación pura).
- **Problema que resuelve:** Confirmar que el producto físico escaneado corresponde al producto del pedido de MercadoLibre.
- **Decisión que impacta:** `correcto: true/false` — determina si el operador debe empacar o reemplazar el producto.
- **Sub-tareas:**
  1. **OCR:** Lee texto de etiquetas, cajas, stickers.
  2. **Extracción de código rotuladora:** Busca número de 7 dígitos en etiqueta blanca.
  3. **Extracción de modelo:** Identifica código de modelo (ej: A25, IP16, Smart Band 7).
  4. **Detección de color:** Identifica color del producto según reglas del tipo.
  5. **Comparación:** Compara modelo/color extraído contra el producto esperado del pedido.

#### C. Lógica de "búsqueda"/comparación

**NO es búsqueda semántica ni retrieval.** Es comparación directa dentro de un prompt de instrucciones.

**Pipeline paso a paso:**

```
1. PREPROCESAMIENTO (servidor, server.js:1744-1764)
   ├── Recibe imagen(es) base64 del frontend
   ├── Detecta MIME type (jpeg/png)
   ├── Strippea prefijo data:image/...
   └── Construye array de imageBlocks para la API

2. CONSTRUCTION DE PROMPT (prompts.js:129-245)
   ├── detectProductType(sku, descripcion) → tipo + config
   ├── findSkuRule(sku) → regla específica del SKU o null
   ├── mergeWithSkuRule(tipoConfig, skuRule) → config final
   ├── Inyecta: dondeVerificar, reglaColor, formatoModelo, notasExtra, _notaSku
   ├── Inyecta: producto esperado (SKU + descripción)
   ├── Inyecta: 7 reglas de comparación de modelos (hardcoded)
   ├── Inyecta: ~15 ejemplos correct/incorrect
   └── Si multi-foto: agrega instrucción de combinar ángulos

3. LLAMADA A CLAUDE (server.js:1784-1791)
   ├── Model: claude-sonnet-4-20250514
   ├── max_tokens: 500 (multi-image) o 400 (single)
   ├── Content: [imageBlock1, ..., imageBlockN, textPrompt]
   └── Single message, role: user

4. PARSING DE RESPUESTA (server.js:1794-1806)
   ├── Extrae texto de response.content[0].text
   ├── Regex /\{[\s\S]*\}/ para extraer JSON
   └── JSON.parse() → result object

5. POST-PROCESAMIENTO (server.js:1809-1867)
   ├── Si result.codigoRotuladora → barcodeCache lookup (V16)
   │   └── Si encontrado → result.skuVinculado = SKU
   └── Si NO skuVinculado → SKU Suggestion Scoring (V17)
       └── Top 3 sugeridos por score
```

**Parámetros relevantes:**
- **max_tokens:** 400-500 (respuesta corta forzada).
- **Modelo:** `claude-sonnet-4-20250514` (visión + razonamiento).
- **Temperatura:** Default de la API (no especificada, probablemente 1.0).
- **No hay top-k, no hay retrieval, no hay embeddings.**

#### D. Repositorio/corpus contra el que "busca"

**Claude NO busca contra un corpus.** Toda la información está en el prompt:

| Fuente | Qué contiene | Cómo se incluye | Actualización |
|---|---|---|---|
| `prompts/config.json` → tipo | Reglas por tipo de producto (13 tipos) | Inyectado en prompt como texto | Realtime (hot-reload en cada request) |
| `prompts/config.json` → skuRules | Reglas por SKU específico (12+ reglas) | Inyectado en prompt como texto | Realtime (hot-reload) |
| Prompt hardcoded | 7 reglas de comparación de modelo, 15+ ejemplos | Siempre presente en el prompt | Solo con deploy |
| `productoEsperado` | SKU + descripción del producto del pedido ML | Inyectado dinámicamente | Realtime (del pedido) |
| Imágenes | Fotos capturadas por el operador | Base64 en el content | Realtime (del operador) |

**Después de la respuesta de Claude, se busca contra:**

| Fuente | Qué contiene | Búsqueda | Actualización |
|---|---|---|---|
| `barcodeCache` (hash en memoria) | ~1500 mapeos código→SKU | Exact match por key | Reload manual o al iniciar servidor |
| `prompts/config.json` → skuRules | 12+ reglas con formatoModelo, dondeVerificar, nota | Substring match (`indexOf`) con scoring | Hot-reload |

#### E. "Contra qué lo compara" exactamente

1. **Claude compara contra instrucciones en el prompt:**
   - La imagen vs. el `productoEsperado` (SKU + descripción del pedido).
   - Usa las reglas de comparación hardcodeadas (IP = iPhone, ignorar 4G/5G, sufijos importantes, etc.).
   - Usa las reglas dinámicas del tipo/SKU (`dondeVerificar`, `reglaColor`, `formatoModelo`).

2. **El servidor compara el código de rotuladora contra:**
   - Hash exacto `barcodeCache[codigoRotuladora]` → registros normalizados (código → SKU).

3. **El scoring de sugerencias compara contra:**
   - Cada key de `skuRules` con substring matching ponderado sobre `formatoModelo`, `dondeVerificar`, `nota`.
   - No hay embeddings, no hay vectores, no hay distancias.

**Criterio de "match" en Claude:** Claude retorna `correcto: true/false` y `confianza: alta/media/baja`. Es una decisión booleana del LLM basada en razonamiento sobre el prompt.

**Criterio de "match" en barcode lookup:** Igualdad exacta de string (`===`) con 2 fallbacks de padding (±1 cero inicial).

**Criterio de "match" en SKU suggestions:** Score > 0 entra en la lista. Top 3 por score descendente. No hay umbral mínimo (un score de 1 ya es "sugerido").

---

### 4.B: USO DE IA #2 - Extracción de Producto (V20)

#### A. Dónde aplica
- **Pantallas:** Verificación principal (cuando no hay producto seleccionado) y Mayorista.
- **Endpoint:** `POST /api/vision/analyze` SIN `producto` en el body.
- **Disparador:** Manual. Operador escanea un producto sin haber seleccionado cuál es en la lista.

#### B. Qué hace exactamente
- **Función:** **Extracción de texto/entidades** (OCR + clasificación).
- **Problema:** Identificar qué producto se escaneó sin saber cuál se esperaba.
- **Decisión:** No produce `correcto/incorrecto`. Produce metadata para matching posterior (V17 o V21).

#### C. Lógica
**Pipeline idéntico a V15** excepto:
- Usa `buildExtractionPrompt()` en vez de `buildVerificationPrompt()`.
- No recibe producto esperado → no hay comparación dentro del prompt.
- Prompt enfocado en OCR puro y clasificación de tipo.

**Output:**
```json
{
  "textoEncontrado": "BTH-F9-5 TRUE WIRELESS ...",
  "codigoRotuladora": "0001234",
  "modeloDetectado": "F9-5",
  "colorDetectado": "Negro",
  "tipoProducto": "auriculares",
  "confianza": "alta"
}
```

#### D/E. Repositorio y comparación
- Claude NO compara contra nada externo. Solo describe lo que ve.
- El resultado alimenta V16 (barcode lookup) y V17 (SKU suggestion) o V21 (mayorista client-side matching).

---

### 4.C: USO DE IA #3 - Generación de Reglas de Config (V30)

#### A. Dónde aplica
- **Pantalla:** Interfaz de configuración de producto (cuando se crea una nueva regla de SKU).
- **Endpoint:** `POST /api/vision/analyze` con `mode: 'config-describe'`.
- **Disparador:** Manual. El operador sube foto de un producto nuevo para generar reglas de verificación.

#### B. Qué hace exactamente
- **Función:** **Generación de instrucciones** a partir de imágenes.
- **Problema:** Crear reglas de verificación para productos nuevos sin intervención manual.
- **Decisión:** Genera contenido que se guarda en `config.json` vía `POST /api/product-config`.

#### C. Lógica
- Usa `buildConfigDescriptionPrompt()` (`prompts.js:306-328`).
- Claude analiza la foto y describe: dónde buscar el código, cómo identificar el color, formato del modelo, notas distintivas.

**Output:**
```json
{
  "dondeVerificar": "Buscar 'F9-5' en recuadro amarillo...",
  "reglaColor": "Puntito de color en el costado...",
  "formatoModelo": "F9-5 o BTH-F9-5",
  "nota": "Caja azul, dice TWS...",
  "tipoProducto": "auriculares",
  "mensajeFoto": "Sacale foto al costado..."
}
```

#### D/E. No hay búsqueda ni comparación — es generación pura.

---

### 4.D: ALGORITMO HEURÍSTICO #1 - SKU Suggestion Scoring (V17)

(Detallado arriba en V17. No usa LLM pero depende de V15/V20.)

### 4.E: ALGORITMO HEURÍSTICO #2 - Mayorista Score Matching (V21)

(Detallado arriba en V21. No usa LLM pero depende de V20.)

---

## 5. CÓMO SE CRUZAN LAS VERIFICACIONES

### 5.1 Cadena de dependencias (flujo ML principal)

```
Webhook/Sync
    │
    ├── V1 (topic filter) ─┐
    ├── V2 (account match) ─┤
    ├── V3 (order status)  ─┤
    ├── V4 (fulfillment)   ─┤──► V5 (shouldProcessOrder) ──► V6 (dedup) ──► Sheet
    ├── V7 (custom mode)   ─┤                                                  │
    ├── V9 (pack detect)   ─┘                                                  │
    │                                                                          │
    │   ┌──────────────────────────────────────────────────────────────────────┘
    │   │
    │   ▼
    │   Operador selecciona envío en UI
    │   │
    │   ├── V19 (detect product type) ──► configura fotos mínimas/máximas
    │   │
    │   ▼
    │   Operador captura foto(s)
    │   │
    │   ├── [CON producto seleccionado]
    │   │   └── V15 (Claude Verification) ──► {correcto, modelo, color, código, confianza}
    │   │       │
    │   │       ├── V16 (Barcode Lookup)
    │   │       │   ├── Hit  → skuVinculado (MÁXIMA CERTEZA)
    │   │       │   └── Miss → V17 (SKU Suggestion)
    │   │       │              └── Top 3 sugeridos
    │   │       │
    │   │       └── Operador confirma/rechaza
    │   │
    │   ├── [SIN producto seleccionado]
    │   │   └── V20 (Claude Extraction) ──► {texto, modelo, color, tipo, confianza}
    │   │       │
    │   │       ├── V16 (Barcode Lookup) ──► si hit, auto-match
    │   │       └── V17 (SKU Suggestion) ──► sugerencias
    │   │
    │   └── V18 (markAsVerified)
    │       └── Estado: Verificado / Parcial (X%)
    │
    └── V24 (actualizarEstados) ──► Despachado / Entregado / Eliminado
        V25 (removeCancelled)
        V26 (shouldClearOldRecords)
        V27 (copiarHistorial)
```

### 5.2 Cadena de dependencias (flujo Mayorista)

```
Jumpseller Sync
    │
    ├── V11 (status=paid)
    ├── V12 (unfulfilled)
    ├── V13 (date range)
    └── V14 (dedup) ──► Sheet Mayorista
                            │
                            ▼
                   Operador abre pedido
                            │
                            ▼
                   Escanea producto (cámara)
                            │
                            ▼
                   V20 (Claude Extraction)
                            │
                            ├── V16 (Barcode Lookup)
                            └── V21 (Score Matching client-side)
                                │
                                ├── Score >= 30 → auto-match item
                                └── Score < 30 → operador elige manual
                                        │
                                        ▼
                               V22 (updateItemVerification)
                                        │
                                        ▼
                               V23 (checkAndUpdateOrderStatus)
                                        │
                                        ├── Todos verificados → Orden "Verificado"
                                        └── Faltan items → sigue pendiente
```

### 5.3 Resultado final y lógica de agregación

**No hay un "score final" único del sistema.** El resultado es un estado por envío/orden:

| Estado | Significado | Cómo se llega |
|---|---|---|
| `Pendiente` | Sin verificar | Estado inicial al agregar a Sheet |
| `Verificado` | 100% de items confirmados | `markAsVerified` con `isParcial=false` |
| `Parcial (X%)` | Algunos items verificados | `markAsVerified` con `isParcial=true` |
| `Despachado` | Enviado sin verificación completa | `actualizarEstados` detecta `shipped` en ML |
| `Entregado` | Llegó al destino | `actualizarEstados` detecta `delivered` en ML |
| (eliminado) | Cancelado | `actualizarEstados` o `removeCancelled` |

**Prioridades de estado (no se sobreescribe):**
- `Verificado` → ya no se toca (V24 hace skip).
- `Despachado` → ya no se toca.
- `Entregado` → ya no se toca.
- `Parcial` → puede pasar a `Verificado` si se completa la verificación, o a `Despachado` si ML reporta envío.

**Orden de ejecución:**
1. Ingesta (webhook/sync) → filtrado → Sheet.
2. Verificación (manual por operador, cuando decide).
3. Post-verificación (cron o manual): actualizar estados, copiar historial.

**No hay short-circuit global:** cada envío se procesa independientemente. No hay agregación entre envíos.

---

## 6. OBSERVABILIDAD Y REPRODUCIBILIDAD

### 6.1 Logs
- **Servidor:** `console.log`/`console.error` en stdout. Cada operación importante logguea:
  - Claude response raw (`server.js:1795`).
  - Barcode lookups hit/miss (`barcodes.js:252-289`).
  - Webhook recibido con payload (`server.js:2152`).
  - Envíos agregados/actualizados.
- **No hay log estructurado** (no JSON logs, no log levels).
- **No hay IDs de trazabilidad** entre request y respuesta de Claude.
- **No se loggean los prompts enviados a Claude** (solo la respuesta).

### 6.2 Auditoría de búsquedas IA
- **Se puede reproducir parcialmente:**
  - La respuesta raw de Claude se loggea.
  - El SKU y producto esperado se pueden reconstruir del pedido ML.
  - Las reglas de config se pueden ver en `prompts/config.json`.
- **NO se puede reproducir completamente:**
  - La imagen enviada no se persiste (base64 descartado después del request).
  - La temperatura del LLM no es 0 → misma imagen puede dar resultados diferentes.
  - No hay versionado del prompt (cambios en `prompts.js` no se trackean por request).

### 6.3 Errores de SKU
- **Registrados en:** Google Sheets pestaña `Errores_SKU` con: Fecha, Hora, SKU, Descripción, Nota, EnvioID, Cuenta, ItemID_ML.
- **Trigger:** Operador reporta manualmente via `POST /api/error-sku`.

### 6.4 Tests existentes
- **No hay tests unitarios ni de integración.**
- **No hay test coverage de IA/retrieval.**
- **No hay tests de los prompts de Claude.**
- El diagnóstico endpoint (`/api/diagnostico/:orderId`) es lo más cercano a un "test" funcional.

### 6.5 Riesgos conocidos

| Riesgo | Área | Severidad | Detalle |
|---|---|---|---|
| **Alucinación de Claude** | V15, V20 | Alta | Claude puede "ver" un código que no existe o leer mal dígitos. No hay doble verificación. |
| **Imagen no persistida** | V15, V20 | Media | No se puede auditar qué imagen envió el operador. |
| **Prompt no versionado** | V15, V20, V30 | Media | Cambios en prompts.js o config.json afectan todas las verificaciones sin trazabilidad. |
| **Cache stale (barcodes)** | V16 | Media | Si se agregan códigos en Sheets sin hacer reload, el cache no los tiene. |
| **Race condition (dedup)** | V6 | Baja | Dos webhooks simultáneos podrían agregar el mismo envío dos veces. |
| **Token expirado sin fix** | V10 | Media | Si el refresh token también expiró, requiere re-auth manual. No hay alerta automática. |
| **Temperatura no fijada** | V15, V20 | Baja | Misma imagen puede dar resultados diferentes en calls sucesivas. |
| **No hay rate limiting** | V15 | Baja | Llamadas rápidas a Claude podrían exceder rate limits de Anthropic. |
| **Scoring sin umbral (V17)** | V17 | Baja | Score de 1 punto ya sugiere un SKU, puede ser ruido. |
| **Client-side matching** | V21 | Media | Corre en el navegador sin validación server-side. Operador podría manipular. |
| **Sin tests** | Todo | Alta | No hay tests unitarios/integración. Cambios en prompts o config podrían romper lógica silenciosamente. |

---

## 7. RESUMEN EJECUTIVO

### Arquitectura de verificación
El sistema implementa un **pipeline secuencial de filtrado + verificación visual asistida por IA**:
1. **Ingesta:** Webhooks de ML + sync periódico filtran órdenes del día.
2. **Verificación:** Operador humano con asistencia de Claude Vision confirma producto-por-producto.
3. **Post-procesamiento:** Actualización batch de estados desde ML API.

### Uso de IA
- **3 modos de Claude Vision** (verificación, extracción, config-describe), todos via `claude-sonnet-4-20250514`.
- **NO hay embeddings, NO hay vector DB, NO hay búsqueda semántica, NO hay retrieval.**
- La IA es un **clasificador visual multimodal** con instrucciones detalladas en prompt.
- **2 algoritmos heurísticos** (substring matching con scoring) post-procesan la salida de Claude.

### Fortalezas
- Reglas de producto específicas y editables sin deploy (`config.json` hot-reload).
- Código de rotuladora como verificación de máxima certeza (hash exacto).
- Diagnóstico endpoint para troubleshooting.

### Debilidades
- Sin tests. Sin logging estructurado. Sin persistencia de imágenes.
- Prompt no versionado. Temperatura no controlada.
- Client-side matching sin validación server-side.
