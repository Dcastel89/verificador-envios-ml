require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

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

function parseSKU(sku) {
  if (!sku) return [];
  const parts = sku.split('/');
  const components = [];
  for (const part of parts) {
    if (part.startsWith('5')) continue;
    if (part.trim() === '') continue;
    components.push(part.trim());
  }
  return components;
}

async function findShipmentInAccount(account, shipmentId) {
  if (!account.accessToken) return null;
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/shipments/${shipmentId}`,
      { headers: { 'Authorization': `Bearer ${account.accessToken}` } }
    );
    return { account: account.name, shipment: response.data, token: account.accessToken };
  } catch (error) {
    return null;
  }
}

async function getShipmentItems(token, shipmentId) {
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/shipments/${shipmentId}/items`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    return response.data;
  } catch (error) {
    return [];
  }
}

async function getItemSKU(token, itemId, variationId) {
  try {
    if (variationId) {
      const response = await axios.get(
        `https://api.mercadolibre.com/items/${itemId}/variations/${variationId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      return response.data.seller_custom_field || response.data.seller_sku || null;
    } else {
      const response = await axios.get(
        `https://api.mercadolibre.com/items/${itemId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      return response.data.seller_custom_field || response.data.seller_sku || null;
    }
  } catch (error) {
    return null;
  }
}

app.get('/api/debug/shipment/:shipmentId', async (req, res) => {
  const { shipmentId } = req.params;
  for (const account of accounts) {
    if (!account.accessToken) continue;
    try {
      const shipmentResponse = await axios.get(
        `https://api.mercadolibre.com/shipments/${shipmentId}`,
        { headers: { 'Authorization': `Bearer ${account.accessToken}` } }
      );
      const itemsResponse = await axios.get(
        `https://api.mercadolibre.com/shipments/${shipmentId}/items`,
        { headers: { 'Authorization': `Bearer ${account.accessToken}` } }
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

app.get('/api/shipment/:shipmentId', async (req, res) => {
  const { shipmentId } = req.params;
  const promises = accounts.map(account => findShipmentInAccount(account, shipmentId));
  const results = await Promise.all(promises);
  const found = results.find(r => r !== null);
  if (!found) {
    return res.status(404).json({ error: 'Envio no encontrado en ninguna cuenta' });
  }
  const token = found.token;
  const items = await getShipmentItems(token, shipmentId);
  const processedItems = [];
  
  for (const item of items) {
    const sku = await getItemSKU(token, item.item_id, item.variation_id);
    const components = parseSKU(sku);
    const title = item.description || 'Sin titulo';
    
    if (components.length > 1) {
      for (const component of components) {
        processedItems.push({
          id: item.item_id + '-' + component,
          title: title,
          sku: component,
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
        quantity: item.quantity,
        isKit: false
      });
    } else {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: sku || 'SIN SKU',
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

app.get('/api/auth/url/:accountName', (req, res) => {
  const { accountName } = req.params;
  const account = accounts.find(a => a.name === accountName.toUpperCase());
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  const redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  const authUrl = 'https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=' + account.clientId + '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.json({ url: authUrl, account: account.name });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.send('Error: No se recibio codigo de autorizacion');
  }
  res.send('<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h1>Codigo recibido</h1><code style="background: #f0f0f0; padding: 10px; display: block; margin: 20px;">' + code + '</code></body></html>');
});

app.post('/api/auth/token', async (req, res) => {
  const { accountName, code } = req.body;
  const account = accounts.find(a => a.name === accountName.toUpperCase());
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  const redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  try {
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
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

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Verificador de Envios ML - Backend funcionando' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Servidor corriendo en puerto ' + PORT);
});
