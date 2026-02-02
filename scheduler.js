var cron = require('node-cron');

var scheduledTasks = [];

function initScheduler(tasks) {
  // tasks = { syncMorning: fn, copyHistory: fn }

  // Sync matutino a las 8:30 de lunes a viernes
  var morningTask = cron.schedule('30 8 * * 1-5', async function() {
    console.log('=== CRON: Ejecutando sync matutino 8:30 ===');
    try {
      await tasks.syncMorning();
    } catch (error) {
      console.error('Error en sync matutino:', error.message);
    }
  }, {
    timezone: 'America/Argentina/Buenos_Aires'
  });
  scheduledTasks.push(morningTask);

  // Copia al historial a las 19:00 de lunes a viernes
  var historyTask = cron.schedule('0 19 * * 1-5', async function() {
    console.log('=== CRON: Ejecutando copia a historial 19:00 ===');
    try {
      await tasks.copyHistory();
    } catch (error) {
      console.error('Error en copia a historial:', error.message);
    }
  }, {
    timezone: 'America/Argentina/Buenos_Aires'
  });
  scheduledTasks.push(historyTask);

  console.log('Scheduler iniciado: sync 8:30, historial 19:00 (lunes a viernes)');
}

function stopScheduler() {
  scheduledTasks.forEach(function(task) {
    task.stop();
  });
  scheduledTasks = [];
  console.log('Scheduler detenido');
}

module.exports = {
  initScheduler: initScheduler,
  stopScheduler: stopScheduler
};
