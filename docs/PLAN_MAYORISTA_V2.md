# Plan General — Sistema de Verificación Final de Pedidos Mayoristas (v2)

**Versión:** 2.0
**Fecha:** 2026-02-06
**Cambios vs v1:** Resolución de 9 inconsistencias detectadas en revisión.

---

## 0) Alcance y propósito (innegociable)

Sistema exclusivamente de verificación final, usado cuando:

- El pedido ya fue pickeado con hojas en papel.
- Todas las unidades están físicamente reunidas.
- Se arma la caja final de envío.
- Pedidos mayoristas de decenas de unidades (~20–50).

El sistema:

- **No** ayuda a buscar productos.
- **No** reemplaza el papel.
- **No** decide picking.
- **Solo** confirma que lo que entra a la caja coincide exactamente con la orden.

---

## 1) Principio rector

> Todo pedido debe recorrer el 100 % de sus ítems antes de cerrarse.

Esto puede lograrse por dos caminos:

- **Fast path** (escaneo total) → si todo es verificable automáticamente.
- **Safe path** (secuencial obligatorio) → en cualquier otro caso.

No hay atajos intermedios.

---

## 2) Inputs soportados — Jerarquía de confianza

El sistema acepta 4 métodos de entrada. Los 4 están **siempre disponibles**, pero tienen distinto nivel de confianza y no todos habilitan el fast path:

| Método | Nivel de confianza | Habilita fast path | Notas |
|---|---|---|---|
| Lector físico (USB/BT) | Máxima | Sí | HID teclado, no requiere interacción táctil. Prioridad sobre otros inputs. |
| Cámara → barcode/QR | Alta | Sí | ZXing o similar, decodificación local. |
| Cámara + IA | Media | **No** | Claude Vision. Requiere envío al servidor. |
| Swipe manual | Baja | **No** | Fallback explícito. Requiere acción deliberada del operador. |

**Regla:** Solo los métodos de confianza alta/máxima (escaneo puro) sostienen el fast path. Usar IA o swipe en cualquier unidad invalida el fast path automáticamente.

---

## 3) Estados y metadata

### 3.1 Estados del pedido

| Estado | Significado |
|---|---|
| `pending_verification` | Pedido abierto, sin verificación iniciada. |
| `verifying_scan_only` | Fast path activo: escaneo continuo en curso. |
| `verifying_sequential` | Safe path activo: verificación ítem por ítem. |
| `verified_scan_only` | Cerrado exitosamente por fast path. |
| `verified_sequential` | Cerrado exitosamente por safe path. |
| `blocked_inconsistency` | Hay ítems marcados como inconsistencia. No se puede cerrar. |

### 3.2 Camino registrado (metadata del cierre)

Al cerrar un pedido se guarda el camino recorrido como metadata, separado del estado:

| Camino | Cuándo se asigna |
|---|---|
| `scan_only` | 100% de unidades verificadas por escaneo, nunca se cayó al secuencial. |
| `sequential` | Se usó el modo secuencial desde el inicio, sin haber pasado por fast path. |
| `mixed` | Empezó en fast path, cayó al secuencial en algún momento. |

**Estado y camino son cosas distintas.** El estado define qué puede hacer el operador; el camino es un registro histórico para auditoría.

---

## 4) Fast Path — Modo Escaneo General

### 4.1 Objetivo

Permitir cerrar el pedido sin pasar por el modo secuencial solo si el 100 % de las unidades se verifica mediante escaneo automático.

### 4.2 Funcionamiento

- Cámara o lector en modo escaneo continuo.
- El operador escanea productos en **cualquier orden**.
- Cada scan:
  - Identifica SKU vía `barcodeCache` (código → SKU).
  - Asigna 1 unidad a un ítem pendiente.
  - Nunca supera la cantidad pedida.

**Regla de asignación (mismo SKU en múltiples líneas):** Se asigna a la **primera línea con cantidad pendiente**, recorriendo de arriba hacia abajo (FIFO). Ejemplo: si la línea 1 pide 5 unidades y la línea 3 pide 3 del mismo SKU, los escaneos 1–5 van a la línea 1 y los 6–8 a la línea 3.

### 4.3 Condiciones estrictas

El pedido queda `verified_scan_only` **solo si**:

- Todos los ítems tienen código escaneable.
- Todas las unidades fueron escaneadas.
- Todos los códigos escaneados tuvieron match en `barcodeCache`.
- **No** se usó IA.
- **No** se usó swipe manual.
- **No** hay excepciones ni inconsistencias.

### 4.4 Invalidación del fast path

Si **cualquier** condición falla, el fast path se invalida automáticamente:

| Evento | Resultado |
|---|---|
| Código escaneado sin match en `barcodeCache` | Invalida. Mensaje: *"Código [X] no encontrado. Verificá este ítem manualmente."* Se registra el código desconocido para futura incorporación al cache. |
| Operador usa IA (foto + Claude) | Invalida. |
| Operador usa swipe manual | Invalida. |
| Operador elige "Ir a secuencial" | Invalida. |

**Al invalidar:** transición automática a `verifying_sequential`. Los escaneos ya realizados se conservan (ver sección 5.5).

---

## 5) Safe Path — Modo Verificación Secuencial

### 5.1 Cuándo se activa

- **Por decisión del operador** (elige "Verificar secuencial" al abrir el pedido).
- **Automáticamente** cuando el fast path se invalida (ver 4.4).

### 5.2 Comportamiento

- Se muestra **un solo ítem** a la vez, en pantalla grande.
- Se deben verificar **todas sus unidades** antes de avanzar al siguiente.
- El recorrido es **obligatorio y completo** (todos los ítems, sin excepción).

### 5.3 Métodos por unidad

| Método | Acción del operador | Qué se registra |
|---|---|---|
| Escaneo (lector físico o cámara) | Escanea código | `scan` |
| Foto + IA | Captura foto, Claude valida | `ia` |
| Swipe manual | Desliza para confirmar | `manual` |

Cada unidad individual registra su método.

### 5.4 Excepción controlada — Inconsistencia

Botón visible en cada ítem: **"Marcar como pendiente / inconsistencia"**

Permite seguir el flujo al siguiente ítem, pero:

- Bloquea el cierre del pedido.
- El pedido pasa a `blocked_inconsistency`.

### 5.5 Transición desde fast path (escaneos previos)

Cuando el fast path se invalida y se cae al secuencial:

1. Los escaneos ya realizados **se conservan** (no se pierden, no se re-escanean).
2. El modo secuencial recorre **todos** los ítems en orden.
3. Los ítems ya verificados por escaneo aparecen marcados como **"verificado por escaneo"** y el operador los **confirma con un toque** (no re-escanea, pero sí los ve).
4. Los ítems pendientes se verifican normalmente (escaneo, IA o swipe).

Esto mantiene el principio de "recorrer el 100%" sin castigar al operador repitiendo trabajo.

### 5.6 Resolución de inconsistencias

Desde el panel global (sección 6), el operador puede tocar un ítem en estado de inconsistencia:

**Opciones:**

| Acción | Resultado | Método registrado |
|---|---|---|
| **"Resolver"** (se verificó y está bien) | El ítem pasa a verificado. | `manual_post_inconsistencia` |
| **"Confirmar faltante"** (realmente falta) | El ítem queda como faltante. El pedido se puede cerrar como parcial. | `faltante_confirmado` |

**En ambos casos:** nota obligatoria (texto libre, mínimo 10 caracteres).

**Se registra:** quién resolvió, cuándo, qué nota dejó, acción tomada.

**Cuando todas las inconsistencias se resuelven:**
- Si todos los ítems están verificados → el pedido vuelve a `verified_sequential`.
- Si hay faltantes confirmados → el pedido se cierra como parcial con detalle de faltantes.

---

## 6) Panel de Pedido Completo (contexto)

### 6.1 Acceso

Disponible **siempre**, desde cualquier pantalla (fast path o secuencial).

### 6.2 Formato

- **En mobile:** bottom sheet que sube desde abajo (como apps de delivery).
- **En desktop:** panel lateral derecho.
- Al cerrarlo, el operador vuelve **exactamente donde estaba**.

### 6.3 Contenido

- Lista completa de SKUs y cantidades.
- Estado por ítem con indicador visual (color/ícono):
  - Pendiente
  - Verificado (con método: escaneo / IA / manual)
  - Inconsistencia
  - Faltante confirmado
- Progreso general: X de Y unidades verificadas.

### 6.4 Interacción

- **Solo lectura** en general: no permite confirmar ni marcar ítems.
- **Excepción única:** tocar un ítem en inconsistencia abre el flujo de resolución (sección 5.6).

Sirve para:
- Visión global del pedido.
- Planificación mental.
- Tranquilidad operativa.
- Resolución de inconsistencias.

---

## 7) Diagrama de transición de estados

```
Operador abre pedido
        │
        ▼
  pending_verification
        │
        ├── Toca "Empezar verificación" (default)
        │         │
        │         ▼
        │   verifying_scan_only ◄─── Fast path por defecto
        │         │
        │         ├── Scan OK + match en cache → sigue en fast path
        │         │         │
        │         │         └── 100% escaneado → verified_scan_only ──► CIERRE
        │         │
        │         ├── Scan sin match en cache ──┐
        │         ├── Usa IA ──────────────────┤
        │         ├── Usa swipe ───────────────┤──► verifying_sequential
        │         └── Toca "Ir a secuencial" ──┘         │
        │                                                │
        ├── Toca "Verificar secuencial" (directo)        │
        │         │                                      │
        │         ▼                                      │
        │   verifying_sequential ◄───────────────────────┘
        │         │
        │         ├── Todos los ítems recorridos + todos verificados
        │         │         │
        │         │         ▼
        │         │   verified_sequential ──► CIERRE
        │         │
        │         └── Algún ítem marcado como inconsistencia
        │                   │
        │                   ▼
        │           blocked_inconsistency
        │                   │
        │                   ├── Resolver todas las inconsistencias
        │                   │         │
        │                   │         ├── Todos OK → verified_sequential ──► CIERRE
        │                   │         └── Hay faltantes → cierre parcial
        │                   │
        │                   └── (no se puede cerrar hasta resolver)
        │
        └── (no hay otros caminos)
```

---

## 8) Cierre del pedido

### 8.1 Condiciones para habilitar cierre

El cierre se habilita **únicamente si**:

- Estado = `verified_scan_only` o `verified_sequential`.
- No hay ítems pendientes sin verificar.
- No hay inconsistencias abiertas (todas resueltas).

**Excepción:** cierre parcial si hay faltantes confirmados (todos los ítems fueron recorridos, algunos marcados como `faltante_confirmado` con nota).

### 8.2 Datos que se guardan al cerrar

| Campo | Descripción |
|---|---|
| Estado final | `verified_scan_only` / `verified_sequential` / `parcial` |
| Camino | `scan_only` / `sequential` / `mixed` |
| Método por unidad | Array: `[{sku, unidad, metodo, timestamp}]` |
| Usuario | Quién verificó |
| Timestamp inicio | Cuándo se abrió la verificación |
| Timestamp cierre | Cuándo se cerró |
| Inconsistencias resueltas | Array: `[{sku, accion, nota, quien, cuando}]` (si hubo) |
| Faltantes | Array: `[{sku, cantidad_faltante, nota}]` (si hubo) |
| Códigos desconocidos | Array de barcodes escaneados sin match (si hubo) |

---

## 9) Principios de diseño (para evitar desviaciones)

1. El sistema **verifica**, no busca.
2. El fast path existe **solo cuando es 100 % seguro**.
3. El modo secuencial **no es un error**, es control.
4. El swipe manual es **válido**, pero queda registrado.
5. Ningún pedido se cierra sin haber **recorrido todo** lo necesario.
6. Los escaneos nunca se descartan, incluso si el path cambia.
7. Toda inconsistencia tiene un camino de resolución claro.
8. Todo queda registrado: método, quién, cuándo, notas.

---

## 10) Integración con el sistema existente

### 10.1 Qué se mantiene igual

| Componente | Archivo | Rol | Cambios |
|---|---|---|---|
| Jumpseller sync (ingesta) | `jumpseller.js` | Trae pedidos mayoristas a Google Sheets | Ninguno |
| Google Sheets (persistencia) | `server.js` / Sheets API | Almacena pedidos e ítems | Se agregan columnas (ver 10.2) |
| V11–V14 (filtros Jumpseller) | `jumpseller.js` | Filtran pedidos por status/fecha/dedup | Ninguno |
| V20 (Claude Vision extracción) | `server.js`, `prompts.js` | Motor de IA para identificar productos | Se mantiene, usado en safe path |
| V16 (Barcode Lookup) | `barcodes.js` | Cache código → SKU | Se mantiene, usado en ambos paths |

### 10.2 Qué cambia

| Componente | Estado actual | Estado nuevo |
|---|---|---|
| V21 (Score Matching client-side) | Scoring con umbral 30 puntos, auto-match | **Se reemplaza** por el nuevo flujo secuencial con métodos explícitos. |
| V22 (updateItemVerification) | Marca ítem + método genérico | **Se adapta** para recibir método por unidad (`scan`, `ia`, `manual`, etc.). |
| V23 (checkAndUpdateOrderStatus) | Verifica si todos los ítems están completos | **Se adapta** para manejar los nuevos estados del pedido. |
| Frontend mayorista | `public/mayorista/index.html` | **Se reescribe** la sección de verificación con los nuevos modos (fast/safe path). |
| Sheets Mayorista | Columnas actuales | **Se agregan:** estado verificación, camino, método por unidad, inconsistencias, timestamps. |

### 10.3 Qué desaparece

- El scoring de 30 puntos (V21) ya no es necesario. El nuevo sistema no hace matching probabilístico: o el escaneo da match exacto, o se verifica manualmente.
- La función `tryMatchModelWithItems` se elimina.

---

## Resumen ultra corto

Sistema de verificación final mayorista con lector físico y cámara, que permite cierre directo solo si el 100 % del pedido se verifica exclusivamente por escaneo automático con match en cache; en cualquier otro caso, exige un flujo secuencial obligatorio por ítem donde cada unidad se verifica por escaneo, IA o swipe manual. Panel global como overlay solo lectura. Inconsistencias con resolución obligatoria y nota. Todo queda registrado: método por unidad, camino, usuario, timestamps. La ingesta (Jumpseller) no cambia; la verificación se reescribe; la persistencia (Sheets) se extiende.
