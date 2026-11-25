const express = require('express');
const ExcelJS = require('exceljs');
const { AppError } = require('../middleware/errorHandler');
const { parseDateRange } = require('../utils/validators');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Escape a value safely according to RFC 4180 CSV rules.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function createExportRouter({ store }) {
  const router = express.Router();

  async function fetchFilteredRows(req) {
    const dateRange = parseDateRange(req.query);
    if (!dateRange.valid) {
      throw new AppError(400, 'Invalid date filter.', dateRange.errors);
    }
    const deviceId =
      typeof req.query.device_id === 'string' && req.query.device_id.trim()
        ? req.query.device_id.trim()
        : null;

    return store.exportReadings({
      from: dateRange.from,
      to: dateRange.to,
      deviceId,
    });
  }

  // Export stored readings as CSV
  router.get(
    '/export.csv',
    asyncHandler(async (req, res) => {
      const rows = await fetchFilteredRows(req);

      const headers = [
        'id',
        'device_id',
        'temperature_c',
        'soil_moisture_pct',
        'oxygen_pct',
        'ph',
        'note',
        'source',
        'created_at',
      ];

      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(
          [
            csvEscape(row.id),
            csvEscape(row.device_id),
            csvEscape(row.temperature),
            csvEscape(row.soil_moisture),
            csvEscape(row.oxygen),
            csvEscape(row.ph),
            csvEscape(row.note),
            csvEscape(row.source),
            csvEscape(row.created_at),
          ].join(',')
        );
      }

      const filename = `compost-twin-readings-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Include UTF-8 BOM so Excel opens French/Arabic characters cleanly
      res.send('\uFEFF' + lines.join('\r\n'));
    })
  );

  // Export stored readings as XLSX using ExcelJS
  router.get(
    '/export.xlsx',
    asyncHandler(async (req, res) => {
      const rows = await fetchFilteredRows(req);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'CompostTwin Station';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Readings', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      sheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Device ID', key: 'device_id', width: 18 },
        { header: 'Temperature (°C)', key: 'temperature', width: 18 },
        { header: 'Soil Moisture (%)', key: 'soil_moisture', width: 18 },
        { header: 'Oxygen (%)', key: 'oxygen', width: 14 },
        { header: 'pH', key: 'ph', width: 10 },
        { header: 'Note', key: 'note', width: 30 },
        { header: 'Source', key: 'source', width: 12 },
        { header: 'Timestamp (UTC)', key: 'created_at', width: 26 },
      ];

      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1B4D3E' },
      };

      for (const row of rows) {
        sheet.addRow({
          id: row.id,
          device_id: row.device_id,
          temperature: row.temperature,
          soil_moisture: row.soil_moisture,
          oxygen: row.oxygen,
          ph: row.ph,
          note: row.note || '',
          source: row.source,
          created_at: row.created_at,
        });
      }

      const filename = `compost-twin-readings-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      await workbook.xlsx.write(res);
      res.end();
    })
  );

  return router;
}

module.exports = { createExportRouter };
