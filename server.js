require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const accounts = [
  {
    name: 'TIENDA',
    clientId: process.env.TIENDA_CLIENT_ID,
    clientSecret: process.env.TIENDA_CLIENT_SECRET,
    accessToken: process.env.TIENDA_ACCESS_TOKEN,
    refreshToken: process.env.TIENDA_REFRESH_TOKEN
  },
  {
    name: 'SHOP',
    clientId: process.env.SHOP_CLIENT_ID,
    clientSecret: process.env.SHOP_CLIENT_SECRET,
    accessToken: process.env.SHOP_ACCESS_TOKEN,
    refreshToken: process.env.SHOP_REFRESH_TOKEN
  },
  {
    name: 'FURST',
    clientId: process.env.FURST_CLIENT_ID,
    clientSecret: process.env.FURST_CLIENT_SECRET,
    accessToken: process.env.FURST_ACCESS_TOKEN,
    refreshToken: process.env.FURST_REFRESH_TOKEN
  }
];

function describeSKU(sku) {
  if (!sku) return '';
  
  if (sku.startsWith('SC')) {
    var colors = { 'A': 'Azul', 'V': 'Verde', 'R': 'Rosa', 'L': 'Lila', 'N': 'Negro' };
    var colorCode = sku.charAt(2);
    var color = colors[colorCode] || colorCode;
    var modelo = sku.substring(3);
    if (modelo.startsWith('i')) {
      return 'Funda Silicona ' + color + ' iPhone ' + modelo.substring(1);
    }
    return 'Funda Silicona ' + color + ' ' + modelo;
  }
  
  if (sku.startsWith('FT')) {
    var modelo = sku.substring(2);
    if (modelo.startsWith('i')) {
      return 'Funda Transparente iPhone ' + modelo.substring(1);
    }
    return 'Funda Transparente ' + modelo;
  }
  
  if (sku.startsWith('VF')) {
    var resto = sku.substring(2);
    if (resto.startsWith('i')) {
      return 'Vidrio iPhone ' + resto.substring(1);
    }
    return 'Vidrio ' + resto;
  }
  
  return sku;
}

function parseSKU(sku) {
  if (!sku) return [];
  var parts = sku.split('/');
  var components = [];
  var seen = {};
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.match(/^5[A-Z0-9]/)) continue;
    if (part === '') continue;
    if (seen[part]) continue;
    seen[part] = true;
    components.push(part);
  }
  return components;
}

async function findShipmentInAccount(account, shipmentId) {
  if (!account.accessToken) return null;
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/shipments/' + shipmentId,
      { headers: { 'Authorization': 'Bearer ' + account.accessToken } }
    );
    return { account: account.name, shipment: response.data, token: account.accessToken };
  } catch (error) {
    return null;
  }
}

async function getShipmentItems(token, shipmentId) {
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/shipments/' + shipmentId + '/items',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    return response.data;
  } catch (error) {
    return [];
  }
}

async function getItemWithVariations(token, itemId) {
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/items/' + itemId + '?include_attributes=all',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    return response.data;
  } catch (error) {
    return null;
  }
}

async function getUserProductSKU(token, userProductId) {
  if (!userProductId) return null;
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/user-products/' + userProductId,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = response.data;
    if (data && data.attributes) {
      for (var i = 0; i < data.attributes.length; i++) {
        var attr = data.attributes[i];
        if (attr.id === 'SELLER_SKU' && attr.values && attr.values[0] && attr.values[0].name) {
          return attr.values[0].name;
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

function findSKUInVariation(item, variationId) {
  if (!item || !item.variations) return null;
  for (var i = 0; i < item.variations.length; i++) {
    var variation = item.variations[i];
    if (variation.id === variationId) {
      if (variation.attributes) {
        for (var j = 0; j < variation.attributes.length; j++) {
          var attr = variation.attributes[j];
          if (attr.id === 'SELLER_SKU' && attr.value_name) {
            return attr.value_name;
          }
        }
      }
      if (variation.seller_custom_field) {
        return variation.seller_custom_field;
      }
    }
  }
  return null;
}

app.get('/api/debug/shipment/:shipmentId', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;
    try {
      var shipmentResponse = await axios.get(
        'https://api.mercadolibre.com/shipments/' + shipmentId,
        { headers: { 'Authorization': 'Bearer ' + account.accessToken } }
      );
      var itemsResponse = await axios.get(
        'https://api.mercadolibre.com/shipments/' + shipmentId + '/items',
        { headers: { 'Authorization': 'Bearer ' + account.accessToken } }
      );
      return res.json({
        account: account.name,
        shipment: shipmentResponse.data,
        items: itemsResponse.data
      });
    } catch (error) {
      continue;
    }
  }
  res.status(404).json({ error: 'No encontrado' });
});

app.get('/api/shipment/:shipmentId', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  var promises = accounts.map(function(account) {
    return findShipmentInAccount(account, shipmentId);
  });
  var results = await Promise.all(promises);
  var found = results.find(function(r) { return r !== null; });
  
  if (!found) {
    return res.status(404).json({ error: 'Envio no encontrado en ninguna cuenta' });
  }
  
  var token = found.token;
  var items = await getShipmentItems(token, shipmentId);
  var processedItems = [];
  
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var sku = null;
    
    // Primero intentar obtener SKU de la variación
    if (item.variation_id) {
      var itemData = await getItemWithVariations(token, item.item_id);
      sku = findSKUInVariation(itemData, item.variation_id);
    }
    
    // Si no hay variación o no se encontró SKU, buscar en user_product_id (catálogo)
    if (!sku && item.user_product_id) {
      sku = await getUserProductSKU(token, item.user_product_id);
    }
    
    var components = parseSKU(sku);
    var title = item.description || 'Sin titulo';
    
    if (components.length > 1) {
      for (var j = 0; j < components.length; j++) {
        var component = components[j];
        processedItems.push({
          id: item.item_id + '-' + component,
          title: title,
          sku: component,
          description: describeSKU(component),
          quantity: item.quantity,
          isKit: true,
          originalSku: sku
        });
      }
    } else if (components.length === 1) {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: components[0],
        description: describeSKU(components[0]),
        quantity: item.quantity,
        isKit: false
      });
    } else {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: sku || 'SIN SKU',
        description: '',
        quantity: item.quantity,
        isKit: false
      });
    }
  }
  
  res.json({
    account: found.account,
    shipmentId: shipmentId,
    status: found.shipment.status,
    items: processedItems
  });
});

app.get('/api/auth/url/:accountName', function(req, res) {
  var accountName = req.params.accountName;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  var redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  var authUrl = 'https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=' + account.clientId + '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.json({ url: authUrl, account: account.name });
});

app.get('/auth/callback', function(req, res) {
  var code = req.query.code;
  if (!code) {
    return res.send('Error: No se recibio codigo de autorizacion');
  }
  res.send('<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h1>Codigo recibido</h1><code style="background: #f0f0f0; padding: 10px; display: block; margin: 20px;">' + code + '</code></body></html>');
});

app.post('/api/auth/token', async function(req, res) {
  var accountName = req.body.accountName;
  var code = req.body.code;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  var redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  try {
    var response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: account.clientId,
        client_secret: account.clientSecret,
        code: code,
        redirect_uri: redirectUri
      },
      headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
    });
    res.json({
      account: account.name,
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in
    });
  } catch (error) {
    res.status(400).json({ error: 'Error al obtener token', details: error.response ? error.response.data : error.message });
  }
});

app.get('/api/status', function(req, res) {
  res.json({ status: 'OK', message: 'Verificador de Envios ML - Backend funcionando' });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Servidor corriendo en puerto ' + PORT);
});
