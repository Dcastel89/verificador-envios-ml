require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de las cuentas de MercadoLibre
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

// Función para parsear SKU y separar componentes
function parseSKU(sku) {
  if (!sku) return [];
  
  const parts = sku.split('/');
  const components = [];
  
  for (const part of parts) {
    // Ignorar si empieza con "5" (es ubicación)
    if (part.startsWith('5')) continue;
    // Ignorar partes vacías
    if (part.trim() === '') continue;
    
    components.push(part.trim());
  }
  
  return components;
}

// Buscar envío en una cuenta específica
async function findShipmentInAccount(account, shipmentId) {
  if (!account.accessToken) return null;
  
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/shipments/${shipmentId}`,
      {
        headers: {
          'Authorization': `Bearer ${account.accessToken}`
        }
      }
    );
    return { account: account.name, shipment: response.data };
  } catch (error) {
    return null;
  }
}

// Obtener items de un envío
async function getShipmentItems(account, shipmentId) {
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/shipments/${shipmentId}/items`,
      {
        headers: {
          'Authorization': `Bearer ${account.accessToken}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error getting shipment items:', error.message);
    return [];
  }
}

// Endpoint principal: buscar envío por ID
app.get('/api/shipment/:shipmentId', async (req, res) => {
  const { shipmentId } = req.params;
  
  // Buscar en todas las cuentas en paralelo
  const promises = accounts.map(account => findShipmentInAccount(account, shipmentId));
  const results = await Promise.all(promises);
  
  // Encontrar la cuenta que tiene el envío
  const found = results.find(r => r !== null);
  
  if (!found) {
    return res.status(404).json({ error: 'Envío no encontrado en ninguna cuenta' });
  }
  
  // Obtener la cuenta que encontró el envío
  const account = accounts.find(a => a.name === found.account);
  
  // Obtener los items del envío
  const items = await getShipmentItems(account, shipmentId);
  
  // Procesar items y expandir SKUs
  const processedItems = [];
  for (const item of items) {
    const sku = item.seller_sku || item.seller_custom_field || '';
    const components = parseSKU(sku);
    
    if (components.length > 1) {
      // Es un kit, agregar cada componente
      for (const component of components) {
        processedItems.push({
          id: `${item.id}-${component}`,
          title: item.title,
          sku: component,
          quantity: item.quantity,
          isKit: true,
          originalSku: sku
        });
      }
    } else if (components.length === 1) {
      // Producto individual
      processedItems.push({
        id: item.id,
        title: item.title,
        sku: components[0],
        quantity: item.quantity,
        isKit: false
      });
    } else {
      // Sin SKU
      processedItems.push({
        id: item.id,
        title: item.title,
        sku: 'SIN SKU',
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

// Endpoint para obtener URL de autorización
app.get('/api/auth/url/:accountName', (req, res) => {
  const { accountName } = req.params;
  const account = accounts.find(a => a.name === accountName.toUpperCase());
  
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  
  const redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios.onrender.com/auth/callback';
  const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${account.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.json({ url: authUrl, account: account.name });
});

// Callback de autorización
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.send('Error: No se recibió código de autorización');
  }
  
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 40px; text-align: center;">
        <h1>✅ Código recibido</h1>
        <p>Código de autorización:</p>
        <code style="background: #f0f0f0; padding: 10px; display: block; margin: 20px;">${code}</code>
        <p>Guardá este código, lo necesitás para obtener el Access Token.</p>
      </body>
    </html>
  `);
});

// Endpoint para intercambiar código por token
app.post('/api/auth/token', async (req, res) => {
  const { accountName, code } = req.body;
  const account = accounts.find(a => a.name === accountName.toUpperCase());
  
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  
  const redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios.onrender.com/auth/callback';
  
  try {
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: account.clientId,
        client_secret: account.clientSecret,
        code: code,
        redirect_uri: redirectUri
      },
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      }
    });
    
    res.json({
      account: account.name,
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in
    });
  } catch (error) {
    res.status(400).json({ 
      error: 'Error al obtener token',
      details: error.response?.data || error.message 
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Verificador de Envíos ML - Backend funcionando' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
