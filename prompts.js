// ============================================
// PROMPTS DE IA - Verificación y Extracción
// Con config JSON editable por tipo de producto
// ============================================

var fs = require('fs');
var path = require('path');

// Cache del config para no leer el archivo en cada request
var configCache = null;
var configLastModified = 0;

function loadConfig() {
  var configPath = path.join(__dirname, 'prompts', 'config.json');
  try {
    var stats = fs.statSync(configPath);
    // Recargar solo si el archivo cambió (permite editar sin reiniciar)
    if (!configCache || stats.mtimeMs !== configLastModified) {
      var raw = fs.readFileSync(configPath, 'utf8');
      configCache = JSON.parse(raw);
      configLastModified = stats.mtimeMs;
      console.log('Config de prompts cargado/recargado');
    }
    return configCache;
  } catch (err) {
    console.error('Error cargando prompts/config.json:', err.message);
    // Retornar config mínimo para que no rompa
    return { tipos: {}, generico: { dondeVerificar: '', reglaColor: '', formatoModelo: '', notasExtra: '' } };
  }
}

/**
 * Detecta el tipo de producto a partir del SKU y/o descripción.
 * Prioridad: 1) prefijo del SKU, 2) palabras clave en descripción, 3) genérico
 */
function detectProductType(sku, descripcion) {
  var config = loadConfig();
  var tipos = config.tipos || {};

  // 1. Buscar por prefijo del SKU (más confiable)
  if (sku) {
    var skuUpper = sku.toUpperCase();
    var keys = Object.keys(tipos);
    for (var i = 0; i < keys.length; i++) {
      var tipo = tipos[keys[i]];
      var prefijos = tipo.prefijos || [];
      for (var j = 0; j < prefijos.length; j++) {
        if (skuUpper.startsWith(prefijos[j].toUpperCase())) {
          return { nombre: keys[i], config: tipo };
        }
      }
    }
  }

  // 2. Buscar por palabras clave en la descripción
  if (descripcion) {
    var descLower = descripcion.toLowerCase();
    var keys2 = Object.keys(tipos);
    for (var i = 0; i < keys2.length; i++) {
      var tipo = tipos[keys2[i]];
      var palabras = tipo.palabrasClave || [];
      for (var j = 0; j < palabras.length; j++) {
        if (descLower.indexOf(palabras[j].toLowerCase()) !== -1) {
          return { nombre: keys2[i], config: tipo };
        }
      }
    }
  }

  // 3. Genérico
  return { nombre: 'generico', config: config.generico || {} };
}

function buildVerificationPrompt(productoEsperado, imageCount) {
  // Extraer sku y descripción del producto
  var sku = '';
  var descripcion = '';
  if (typeof productoEsperado === 'object' && productoEsperado !== null) {
    sku = productoEsperado.sku || '';
    descripcion = productoEsperado.descripcion || '';
  } else {
    // Compatibilidad: si viene como string, usarlo como descripción
    descripcion = productoEsperado || '';
  }

  // Detectar tipo de producto
  var tipoDetectado = detectProductType(sku, descripcion);
  var tipoConfig = tipoDetectado.config;

  // Texto del producto esperado para mostrar en el prompt
  var textoProducto = descripcion || sku || 'No especificado';

  // Prefijo multi-foto
  var multiPhotoPrefix = '';
  if (imageCount > 1) {
    multiPhotoPrefix = 'IMPORTANTE: Recibís ' + imageCount + ' fotos del MISMO producto desde distintos ángulos. Analizá TODAS las fotos en conjunto para dar una respuesta más precisa. Si una foto muestra el frente y otra el lateral o la etiqueta, combiná la información.\n\n';
  }

  // Sección específica del tipo de producto (inyectada desde config)
  var seccionTipo = '';
  if (tipoConfig.dondeVerificar) {
    seccionTipo += 'DÓNDE BUSCAR CÓDIGO/MODELO:\n' + tipoConfig.dondeVerificar + '\n\n';
  }
  if (tipoConfig.reglaColor) {
    seccionTipo += 'REGLA DE COLOR PARA ESTE PRODUCTO:\n' + tipoConfig.reglaColor + '\n\n';
  }
  if (tipoConfig.formatoModelo) {
    seccionTipo += 'FORMATO DE MODELO ESPERADO:\n' + tipoConfig.formatoModelo + '\n\n';
  }
  if (tipoConfig.notasExtra) {
    seccionTipo += 'NOTAS ADICIONALES:\n' + tipoConfig.notasExtra + '\n\n';
  }

  return multiPhotoPrefix + 'TAREA: Leer códigos y verificar productos.\n\n' +
'PASO 1 - BUSCAR CÓDIGO DE ROTULADORA (PRIORIDAD MÁXIMA):\n' +
'Buscá en la imagen una ETIQUETA BLANCA PEQUEÑA con un número de 7 dígitos (ejemplo: 0000001, 0001234).\n' +
'- Puede estar pegada en una funda, en un papel, o en cualquier superficie\n' +
'- Si encontrás este código, TRANSCRIBILO EXACTAMENTE en el campo "codigoRotuladora"\n' +
'- Este código es MÁS IMPORTANTE que cualquier otra cosa\n\n' +
'PASO 2 - Verificar el producto:\n' +
seccionTipo +
'PRODUCTO ESPERADO DEL PEDIDO:\n' +
textoProducto + '\n\n' +
'REGLAS DE COMPARACIÓN DE MODELOS:\n\n' +
'1. IGNORAR TEXTO EXTRA EN ETIQUETAS - Solo importa el código de modelo:\n' +
'   - Ignorar marcas: "MOTO G15" = "G15", "Samsung A25" = "A25"\n' +
'   - Ignorar texto adicional: "SX", "For", "Galaxy", "Phone case", etc.\n' +
'   - Ejemplo: "For Samsung Galaxy A25 SX" = "A25" ✓\n\n' +
'2. ABREVIATURA "IP" = iPhone (MUY COMÚN EN FUNDAS):\n' +
'   - "IP17" = "iPhone 17" = "17"\n' +
'   - "IP16 Pro" = "iPhone 16 Pro" = "16 Pro"\n' +
'   - "IP15 Pro Max" = "iPhone 15 Pro Max" = "15 Pro Max"\n' +
'   - "IP14" = "iPhone 14" = "14"\n' +
'   - Ejemplo: Pedido "iPhone 16", foto dice "IP16" → CORRECTO\n' +
'   - Ejemplo: Pedido "16 Pro", foto dice "IP16 Pro" → CORRECTO\n\n' +
'3. SUFIJOS IMPORTANTES QUE DEBEN COINCIDIR EXACTAMENTE:\n' +
'   Plus (o +), Ultra, Pro, Pro Max, Air, Fusion, Neo\n' +
'   - A15 ≠ A15 Plus (Plus es importante)\n' +
'   - iPhone 15 ≠ iPhone 15 Pro Max (Pro Max es importante)\n' +
'   - A55 ≠ A55 Ultra (Ultra es importante)\n' +
'   - Redmi Note 14 ≠ Redmi Note 14 Pro (Pro es importante)\n\n' +
'4. OTROS SUFIJOS TAMBIÉN SON DIFERENTES - Ser estricto:\n' +
'   - A03 ≠ A03s ≠ A03 Core (son modelos distintos!)\n' +
'   - A15 ≠ A16 (números diferentes = modelos diferentes)\n' +
'   - G24 ≠ G24 Power (con sufijo = modelo diferente)\n' +
'   - Redmi 14 ≠ Redmi Note 14 (Note es otro modelo)\n\n' +
'5. EJEMPLOS DE COINCIDENCIAS CORRECTAS:\n' +
'   - Pedido "G15", foto dice "MOTO G15" → CORRECTO (ignorar MOTO)\n' +
'   - Pedido "A25", foto dice "For Samsung Galaxy A25 SX" → CORRECTO (ignorar texto extra)\n' +
'   - Pedido "A15 Plus", foto dice "A15+" → CORRECTO (+ equivale a Plus)\n' +
'   - Pedido "iPhone 16", foto dice "IP16" → CORRECTO (IP = iPhone)\n' +
'   - Pedido "16 Pro Max", foto dice "IP16 Pro Max" → CORRECTO\n' +
'   - Pedido "Smart Band 7", foto caja dice "Smart Band 7" → CORRECTO\n\n' +
'6. EJEMPLOS DE COINCIDENCIAS INCORRECTAS:\n' +
'   - Pedido "A03", foto dice "A03s" → INCORRECTO (sufijo s es diferente)\n' +
'   - Pedido "A15", foto dice "A15 Plus" → INCORRECTO (Plus es importante)\n' +
'   - Pedido "iPhone 15", foto dice "iPhone 15 Pro" → INCORRECTO (Pro es importante)\n' +
'   - Pedido "G24", foto dice "G24 Power" → INCORRECTO (variante diferente)\n' +
'   - Pedido "IP16", foto dice "IP16 Pro" → INCORRECTO (Pro es importante)\n' +
'   - Pedido "Smart Band 7", foto dice "Smart Band 8" → INCORRECTO\n\n' +
'7. REGLA ESPECIAL PARA FUNDAS Y 4G/5G:\n' +
'   - Para fundas: IGNORAR "4G" o "5G" esté separado O PEGADO al modelo\n' +
'   - "A265G", "A265g", "A26 5G", "A26 5g" → todos son "A26"\n' +
'   - "A154G", "A15 4G" → es "A15"\n' +
'   - EXCEPCIÓN ÚNICA: A22 (sí distinguir A22 4G vs A22 5G)\n' +
'   - Ejemplo: Pedido "A26", foto dice "A265G" → CORRECTO (ignorar 5G pegado)\n' +
'   - Ejemplo: Pedido "A26", foto dice "A26 5g" → CORRECTO (ignorar 5g)\n' +
'   - Ejemplo: Pedido "A22 4G", foto dice "A225G" → INCORRECTO (A22 es excepción)\n\n' +
'INSTRUCCIONES:\n' +
'1. Extraé el CÓDIGO DE MODELO de la etiqueta (ignorá la marca)\n' +
'2. Compará el código con el pedido usando las reglas anteriores\n' +
'3. Verificá el color según la regla de color indicada arriba\n\n' +
'- El fondo suele ser madera, ignoralo.\n' +
'- Colores comunes: Negro, Blanco, Transparente, Rojo, Azul, Rosa, Lila, Verde, Celeste, Amarillo\n\n' +
'Respondé SOLO con este JSON:\n' +
'{\n' +
'  "codigoRotuladora": "código de 7 dígitos si lo ves (ej: 0000001), o null si no hay",\n' +
'  "correcto": true/false,\n' +
'  "productoDetectado": "descripción breve de lo que ves en la foto",\n' +
'  "modeloDetectado": "código del modelo sin marca (ej: A25, G15, Smart Band 7)",\n' +
'  "colorDetectado": "color del producto según la regla de color",\n' +
'  "motivo": "si es incorrecto, explicá por qué usando las reglas",\n' +
'  "confianza": "alta/media/baja"\n' +
'}';
}

function buildExtractionPrompt(imageCount) {
  var multiPhotoPrefix = '';
  if (imageCount > 1) {
    multiPhotoPrefix = 'IMPORTANTE: Recibís ' + imageCount + ' fotos del MISMO producto desde distintos ángulos. Analizá TODAS las fotos en conjunto y combiná la información de todas.\n\n';
  }

  return multiPhotoPrefix + 'TU TAREA PRINCIPAL ES LEER TEXTO. Buscá cualquier texto, número o código visible en la imagen y transcribilo.\n\n' +
'PASO 1 - BUSCAR Y LEER TEXTO (LO MÁS IMPORTANTE):\n' +
'Buscá texto en CUALQUIER parte de la imagen:\n' +
'- Papeles, papelitos, notas (aunque estén arrugados o pequeños)\n' +
'- Etiquetas blancas pequeñas (muy comunes en fundas de silicona)\n' +
'- Stickers, calcomanías\n' +
'- Etiquetas impresas en bolsas\n' +
'- Cajas de productos (smartbands, auriculares, relojes, etc.)\n' +
'- Cualquier cosa con texto impreso o escrito\n\n' +
'SI VES TEXTO → LÉELO Y TRANSCRIBILO EXACTAMENTE\n\n' +
'PASO 2 - Identificar el producto:\n' +
'- Color real del producto (si NO hay indicador de color visible, asumir NEGRO)\n' +
'- Tipo: funda silicona, funda transparente, vidrio templado, smartband, auriculares, cargador, cable, reloj inteligente, etc.\n\n' +
'CÓDIGOS IMPORTANTES A BUSCAR:\n' +
'- Código de rotuladora: 7 dígitos numéricos (ej: 0000001, 0001234)\n' +
'- Modelo: códigos como A25, G51, B12, "For A06", "IP16", "Smart Band 7", "Redmi Buds 4", etc.\n\n' +
'IGNORAR en el modelo: "Fashion Case", "New", "Phone case", "Made in China", "SX", "For", "Galaxy", marcas como "Samsung", "MOTO", "Xiaomi"\n\n' +
'ABREVIATURA "IP" = iPhone (MUY COMÚN EN FUNDAS):\n' +
'- "IP17" → reportar "iPhone 17" o "17"\n' +
'- "IP16 Pro" → reportar "iPhone 16 Pro" o "16 Pro"\n' +
'- "IP15 Pro Max" → reportar "iPhone 15 Pro Max" o "15 Pro Max"\n\n' +
'SUFIJOS IMPORTANTES QUE SÍ DEBEN INCLUIRSE EN EL MODELO:\n' +
'Plus (o +), Ultra, Pro, Pro Max, Air, Fusion, Neo\n' +
'- Si dice "A15+" reportar "A15 Plus"\n' +
'- Si dice "iPhone 15 Pro Max" reportar "15 Pro Max"\n\n' +
'REGLA 4G/5G (MUY IMPORTANTE):\n' +
'- IGNORAR "4G" o "5G" esté separado O PEGADO al modelo\n' +
'- "A265G" → reportar "A26" (quitar el 5G pegado)\n' +
'- "A265g" → reportar "A26"\n' +
'- "A26 5G" → reportar "A26"\n' +
'- "A154G" → reportar "A15"\n' +
'- EXCEPCIÓN ÚNICA: A22 (reportar "A22 4G" o "A22 5G")\n\n' +
'TIPOS DE PRODUCTO A IDENTIFICAR:\n' +
'- Funda silicona / funda transparente / funda rígida\n' +
'- Vidrio templado / protector de pantalla\n' +
'- Smartband / pulsera inteligente (ej: Smart Band 7, Mi Band 8)\n' +
'- Auriculares / earbuds (ej: Redmi Buds 4, Haylou GT1)\n' +
'- Cargador / fuente (indicar watts: 10W, 20W, 33W, 67W)\n' +
'- Cable USB (tipo: USB-C, Lightning, Micro USB)\n' +
'- Reloj inteligente / smartwatch\n' +
'- Otro accesorio\n\n' +
'Respondé SOLO con este JSON:\n' +
'{\n' +
'  "textoEncontrado": "TODO el texto que puedas leer en la imagen, transcrito exactamente",\n' +
'  "codigoRotuladora": "código de 7 dígitos si lo ves, o null",\n' +
'  "modeloDetectado": "código de modelo extraído del texto, o null",\n' +
'  "colorDetectado": "color del producto (NEGRO si no hay indicador visible)",\n' +
'  "tipoProducto": "funda silicona/funda transparente/vidrio/smartband/auriculares/cargador/cable/reloj/otro",\n' +
'  "confianza": "alta/media/baja"\n' +
'}';
}

module.exports = {
  buildVerificationPrompt: buildVerificationPrompt,
  buildExtractionPrompt: buildExtractionPrompt,
  detectProductType: detectProductType,
  loadConfig: loadConfig
};
