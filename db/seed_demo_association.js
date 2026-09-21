// Carga una asociación de DEMOSTRACIÓN con datos ficticios extensos en las tablas tz_* del
// modulo "Pruebas" (trazabilidad nativa), para poder probar todos los formularios, filtros,
// cargues masivos y exportes sin depender de datos reales de ninguna asociación de Genesis Traza.
// Es idempotente: si ya existe el centro DEMO-01 no vuelve a crear nada.
require('dotenv').config();
const pool = require('../db/pool');

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randomInt(0, arr.length - 1)]; }
function pad(n, len) { return String(n).padStart(len, '0'); }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function randomDate(daysAgoMax, daysAgoMin) {
  daysAgoMin = daysAgoMin || 0;
  const d = new Date();
  d.setDate(d.getDate() - randomInt(daysAgoMin, daysAgoMax));
  return dateStr(d);
}

const NOMBRES = ['Carlos', 'Maria', 'Jose', 'Luz', 'Pedro', 'Ana', 'Luis', 'Rosa', 'Jorge', 'Sandra',
  'Miguel', 'Diana', 'Fernando', 'Claudia', 'Ricardo', 'Patricia', 'Alberto', 'Marcela', 'Julio', 'Esperanza',
  'Wilson', 'Yolanda', 'Hector', 'Gloria', 'Nelson', 'Consuelo', 'Edgar', 'Beatriz', 'Rafael', 'Martha',
  'Alvaro', 'Amparo', 'Gustavo', 'Nubia', 'Oscar', 'Stella', 'Fabio', 'Doris', 'Ramiro', 'Ligia'];
const APELLIDOS = ['Gomez', 'Rodriguez', 'Martinez', 'Lopez', 'Garcia', 'Perez', 'Sanchez', 'Ramirez',
  'Torres', 'Diaz', 'Vargas', 'Castro', 'Ruiz', 'Alvarez', 'Romero', 'Suarez', 'Rojas', 'Moreno',
  'Mendoza', 'Jimenez', 'Herrera', 'Medina', 'Aguilar', 'Cardenas', 'Guerrero', 'Nino', 'Pena', 'Cruz'];
const VEHICULOS = ['Zorra de traccion humana', 'Triciclo', 'Carreta', 'Vehiculo de traccion animal', 'Ninguno'];
const EPS_LIST = ['Nueva EPS', 'Sura EPS', 'Sanitas', 'Compensar', 'Famisanar'];
const ARL_LIST = ['Sura ARL', 'Positiva', 'Colmena Seguros'];
const LOCALIDADES = ['Usaquen', 'Chapinero', 'Santa Fe', 'San Cristobal', 'Kennedy', 'Bosa', 'Ciudad Bolivar', 'Suba'];
const COMPRADORES = ['Recicladora del Norte SAS', 'Papeles y Carton de Colombia', 'Metalicos Bogota SAS',
  'Plasticos Reciclados LTDA', 'Vidrios y Envases SAS'];

function fakeDocumento() { return String(randomInt(1000000000, 1099999999)); }
function fakeTelefono() { return '3' + String(randomInt(100000000, 199999999)); }
function fakeDireccion() { return 'Calle ' + randomInt(1, 130) + ' # ' + randomInt(1, 99) + '-' + randomInt(1, 99); }
function fakeNombreCompleto() { return pick(NOMBRES) + ' ' + pick(APELLIDOS) + ' ' + pick(APELLIDOS); }

async function bulkInsert(client, table, columns, rows) {
  if (rows.length === 0) return [];
  const chunkSize = 300;
  const ids = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, idx) => {
      const base = idx * columns.length;
      columns.forEach((col) => values.push(row[col]));
      return '(' + columns.map((_, k) => '$' + (base + k + 1)).join(',') + ')';
    }).join(',');
    const result = await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} RETURNING id`, values);
    result.rows.forEach((r) => ids.push(r.id));
  }
  return ids;
}

async function catalogoMap(client, categoria) {
  const r = await client.query('SELECT id, descripcion FROM tz_catalogos WHERE categoria = $1', [categoria]);
  return r.rows;
}

async function main() {
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT id FROM tz_centros WHERE cod_centro = 'DEMO-01'");
    if (existing.rows.length > 0) {
      console.log('Ya existe la asociacion demo (DEMO-01, id=' + existing.rows[0].id + '). No se vuelve a sembrar. Borra sus filas primero si quieres regenerarla.');
      return;
    }

    await client.query('BEGIN');

    // 1) Centro demo
    const centro = await client.query(
      `INSERT INTO tz_centros (cod_centro, desc_centro, rup_numero, rup_fecha_inscripcion, eca_numero, id_tipo_destino, numero_sitio_destino)
       VALUES ('DEMO-01', 'Asociacion Recicladores Unidos (DEMO)', 'RUP-DEMO-0001', '2023-03-15', 'ECA-DEMO-0001',
         (SELECT id FROM tz_catalogos WHERE categoria = 'destinos_rechazo' AND codigo = '1'), '9999')
       RETURNING id`
    );
    const idCentro = centro.rows[0].id;

    // 2) Localidades (si no existen ya, se agregan; son catalogo geografico, no exclusivo de este centro)
    const localidadIds = [];
    for (const nombre of LOCALIDADES) {
      const found = await client.query('SELECT id FROM tz_localidades WHERE desc_localidad = $1', [nombre]);
      if (found.rows.length) { localidadIds.push(found.rows[0].id); continue; }
      const inserted = await client.query(
        `INSERT INTO tz_localidades (cod_localidad, desc_localidad, ciudad) VALUES ($1,$2,'Bogota') RETURNING id`,
        [nombre.substring(0, 3).toUpperCase(), nombre]
      );
      localidadIds.push(inserted.rows[0].id);
    }

    // 3) Bodegas
    const bodegaIds = await bulkInsert(client, 'tz_bodegas', ['id_centro', 'cod_bodega', 'desc_bodega', 'desc_ubicacion', 'direccion'],
      ['Norte', 'Centro', 'Sur'].map((nombre, i) => ({
        id_centro: idCentro, cod_bodega: 'BOD-' + pad(i + 1, 2), desc_bodega: 'Bodega ' + nombre,
        desc_ubicacion: 'Bodega ' + nombre + ' (DEMO)', direccion: fakeDireccion()
      })));

    // 4) Numacros
    const numacroIds = await bulkInsert(client, 'tz_numacros', ['id_centro', 'id_localidad', 'cod_numacro'],
      localidadIds.map((idLocalidad, i) => ({ id_centro: idCentro, id_localidad: idLocalidad, cod_numacro: 'NUM-' + pad(i + 1, 3) })));

    // 5) Recicladores
    const NUM_RECICLADORES = 40;
    const recicladorRows = [];
    for (let i = 0; i < NUM_RECICLADORES; i++) {
      recicladorRows.push({
        id_centro: idCentro,
        nombre_completo: fakeNombreCompleto(),
        nro_documento: fakeDocumento(),
        estado: Math.random() < 0.9 ? 'Activo' : 'Inactivo',
        fecha_exp_documento: randomDate(6000, 3000),
        fecha_nacimiento: randomDate(18000, 7000),
        direccion: fakeDireccion(),
        telefono: fakeTelefono(),
        tipo_de_vehiculo: pick(VEHICULOS),
        placa: Math.random() < 0.15 ? ('ABC' + randomInt(100, 999)) : null
      });
    }
    const recicladorIds = await bulkInsert(client, 'tz_recicladores',
      ['id_centro', 'nombre_completo', 'nro_documento', 'estado', 'fecha_exp_documento', 'fecha_nacimiento', 'direccion', 'telefono', 'tipo_de_vehiculo', 'placa'],
      recicladorRows);

    // 6) Macrorrutas
    const macrorrutaIds = await bulkInsert(client, 'tz_macrorrutas', ['id_centro', 'cod_macrorruta', 'desc_macrorruta'],
      ['Norte', 'Centro', 'Sur', 'Occidente', 'Oriente'].map((nombre, i) => ({
        id_centro: idCentro, cod_macrorruta: 'MR-' + pad(i + 1, 2), desc_macrorruta: 'Macrorruta ' + nombre
      })));

    // 7) Formalizacion (8 fases del Decreto 596/2016)
    const FASES = [
      'Inscripcion en el RUP', 'Area de servicio, toneladas, ECA y vehiculos', 'Adopcion del CCU',
      'Portafolio, plan de negocio, base de usuarios y web', 'Calibracion de basculas y supervisores',
      'Planta de personal y microrrutas', 'Registro de PQR y planes de emergencia', 'Estados financieros y area georreferenciada'
    ];
    const faseRows = FASES.map((desc, i) => {
      const fase = i + 1;
      const estado = fase <= 4 ? 'Completada' : (fase === 5 ? 'En proceso' : 'Pendiente');
      return {
        id_centro: idCentro, fase, descripcion_fase: desc, estado,
        fecha_completada: estado === 'Completada' ? randomDate(700, 100) : null,
        observaciones: estado === 'Pendiente' ? 'Pendiente por programar.' : null
      };
    });
    await bulkInsert(client, 'tz_formalizacion_fases',
      ['id_centro', 'fase', 'descripcion_fase', 'estado', 'fecha_completada', 'observaciones'], faseRows);

    // 8) PQR
    const pqrTipos = ['Peticion', 'Queja', 'Reclamo'];
    const pqrEstados = ['Abierta', 'En proceso', 'Cerrada'];
    const pqrRows = [];
    for (let i = 0; i < 15; i++) {
      const estado = pick(pqrEstados);
      pqrRows.push({
        id_centro: idCentro, tipo: pick(pqrTipos), fecha: randomDate(180, 1),
        nombre_solicitante: fakeNombreCompleto(), documento_solicitante: fakeDocumento(),
        descripcion: 'Solicitud de prueba relacionada con el servicio de aprovechamiento (DEMO).',
        estado, fecha_respuesta: estado === 'Cerrada' ? randomDate(30, 1) : null,
        respuesta: estado === 'Cerrada' ? 'Caso atendido y cerrado (DEMO).' : null
      });
    }
    await bulkInsert(client, 'tz_pqr',
      ['id_centro', 'tipo', 'fecha', 'nombre_solicitante', 'documento_solicitante', 'descripcion', 'estado', 'fecha_respuesta', 'respuesta'], pqrRows);

    // 9) Seguridad social (una fila por reciclador)
    const seguridadRows = recicladorIds.map((idReciclador) => {
      const afiliadoEps = Math.random() < 0.85;
      const afiliadoArl = Math.random() < 0.75;
      const afiliadoBeps = Math.random() < 0.5;
      return {
        id_reciclador: idReciclador,
        eps: afiliadoEps ? pick(EPS_LIST) : null,
        estado_afiliacion_eps: afiliadoEps ? 'Afiliado' : 'Sin afiliar',
        arl: afiliadoArl ? pick(ARL_LIST) : null,
        estado_afiliacion_arl: afiliadoArl ? 'Afiliado' : 'Sin afiliar',
        base_cotizacion_arl: afiliadoArl ? 1300000 : null,
        beps_afiliado: afiliadoBeps,
        aporte_beps_mensual: afiliadoBeps ? randomInt(20000, 65000) : null,
        fecha_actualizacion: randomDate(60, 1)
      };
    });
    await bulkInsert(client, 'tz_seguridad_social',
      ['id_reciclador', 'eps', 'estado_afiliacion_eps', 'arl', 'estado_afiliacion_arl', 'base_cotizacion_arl', 'beps_afiliado', 'aporte_beps_mensual', 'fecha_actualizacion'],
      seguridadRows);

    // 10) Microrrutas + detalle
    const microrrutaIds = await bulkInsert(client, 'tz_formulario_microrrutas', ['id_centro', 'id_reciclador', 'fecha_entrada_operacion', 'estado'],
      Array.from({ length: 10 }).map(() => ({
        id_centro: idCentro, id_reciclador: pick(recicladorIds),
        fecha_entrada_operacion: randomDate(700, 100), estado: pick(['Activa', 'Activa', 'Suspendida'])
      })));

    const tiposMicrorruta = await catalogoMap(client, 'tipos_microrruta');
    const estacionesTransferencia = await catalogoMap(client, 'estaciones_transferencia');
    const microDetalleRows = [];
    for (let i = 0; i < 15; i++) {
      const horaInicio = pad(randomInt(5, 9), 2) + ':00';
      microDetalleRows.push({
        id_formulario_microrruta: pick(microrrutaIds),
        desc_microrruta: 'Recorrido ' + (i + 1) + ' (DEMO)',
        id_tipo_microrruta: pick(tiposMicrorruta).id,
        direccion_inicio: fakeDireccion(), hora_inicio: horaInicio,
        direccion_finalizacion: fakeDireccion(), hora_finalizacion: pad(randomInt(10, 14), 2) + ':00',
        distancia_via_pavimentada: randomInt(2, 15), distancia_via_no_pavimentada: randomInt(0, 4),
        frecuencia_semanal: randomInt(1, 6), dias_frecuencia: pick(['Lunes,Miercoles,Viernes', 'Martes,Jueves', 'Todos los dias']),
        id_estacion_transferencia: pick(estacionesTransferencia).id, tipo_barrido: pick(['Manual', 'Mecanico'])
      });
    }
    await bulkInsert(client, 'tz_formulario_microrrutas_detalle',
      ['id_formulario_microrruta', 'desc_microrruta', 'id_tipo_microrruta', 'direccion_inicio', 'hora_inicio',
        'direccion_finalizacion', 'hora_finalizacion', 'distancia_via_pavimentada', 'distancia_via_no_pavimentada',
        'frecuencia_semanal', 'dias_frecuencia', 'id_estacion_transferencia', 'tipo_barrido'], microDetalleRows);

    // 11) Usuarios del servicio (SUI)
    const usoOpts = await catalogoMap(client, 'usuario_uso');
    const tipoOpts = await catalogoMap(client, 'usuario_tipo');
    const multiOpts = await catalogoMap(client, 'usuario_multiusuario');
    const ubicacionOpts = await catalogoMap(client, 'usuario_ubicacion');
    const claseOpts = await catalogoMap(client, 'usuario_clase_de_uso');
    const aforoOpts = await catalogoMap(client, 'usuario_tipo_de_aforo');
    const NUM_USUARIOS = 60;
    const usuarioRows = [];
    for (let i = 0; i < NUM_USUARIOS; i++) {
      usuarioRows.push({
        id_centro: idCentro, id_numacro: pick(numacroIds),
        nuis_nuid: 'NUID-' + pad(i + 1, 5),
        direccion_usuario: fakeDireccion(),
        id_usuario_uso: pick(usoOpts).id, id_usuario_tipo: pick(tipoOpts).id,
        id_usuario_multiusuario: pick(multiOpts).id, id_usuario_ubicacion: pick(ubicacionOpts).id,
        id_usuario_clase_de_uso: pick(claseOpts).id, id_usuario_tipo_de_aforo: pick(aforoOpts).id
      });
    }
    const usuarioIds = await bulkInsert(client, 'tz_usuarios',
      ['id_centro', 'id_numacro', 'nuis_nuid', 'direccion_usuario', 'id_usuario_uso', 'id_usuario_tipo',
        'id_usuario_multiusuario', 'id_usuario_ubicacion', 'id_usuario_clase_de_uso', 'id_usuario_tipo_de_aforo'], usuarioRows);

    // 12) Aprovechamiento (2 periodos por usuario)
    const aprovechamientoRows = [];
    for (const idUsuario of usuarioIds) {
      for (const periodo of ['2026-01', '2026-02']) {
        aprovechamientoRows.push({
          id_centro: idCentro, id_usuario: idUsuario, id_numacro: pick(numacroIds),
          periodo, toneladas: (randomInt(5, 80) / 100)
        });
      }
    }
    await bulkInsert(client, 'tz_formulario_aprovechamiento', ['id_centro', 'id_usuario', 'id_numacro', 'periodo', 'toneladas'], aprovechamientoRows);

    // 13) Recursos
    await bulkInsert(client, 'tz_formulario_recursos', ['id_centro', 'fecha', 'nuap', 'operador', 'valor'],
      Array.from({ length: 5 }).map((_, i) => ({
        id_centro: idCentro, fecha: randomDate(300, 30), nuap: 'NUAP-' + pad(i + 1, 3),
        operador: 'Operador Aseo Demo ' + (i + 1), valor: randomInt(500000, 5000000)
      })));

    // 14) Ventas
    const materialesVenta = ['Carton', 'Papel Archivo', 'Pet', 'Vidrio', 'Chatarra'];
    const ventaRows = [];
    const idNit = (await catalogoMap(client, 'tipos_identificacion')).find((c) => c.descripcion === 'NIT').id;
    for (let i = 0; i < 20; i++) {
      const kg = randomInt(200, 4000);
      const valorKilo = randomInt(200, 2500);
      const valorSinIva = kg * valorKilo;
      const iva = Math.round(valorSinIva * 0.19);
      ventaRows.push({
        id_centro: idCentro, anio: 2026, periodo: pick(['2026-01', '2026-02']),
        fecha_habilitacion: randomDate(400, 200), fecha_certificacion: randomDate(200, 50),
        id_tipo_identificacion: idNit, nro_identificacion: String(randomInt(800000000, 899999999)),
        nro_factura: 'FAC-' + pad(i + 1, 4), nombre_comprador: pick(COMPRADORES),
        material: pick(materialesVenta), kg, toneladas: kg / 1000,
        valor_kilo: valorKilo, valor_sin_iva: valorSinIva, iva, valor_con_iva: valorSinIva + iva,
        depto_origen: 'Cundinamarca', municipio_origen: 'Bogota', origen_residuos: 'Domiciliario'
      });
    }
    await bulkInsert(client, 'tz_formulario_ventas',
      ['id_centro', 'anio', 'periodo', 'fecha_habilitacion', 'fecha_certificacion', 'id_tipo_identificacion',
        'nro_identificacion', 'nro_factura', 'nombre_comprador', 'material', 'kg', 'toneladas', 'valor_kilo',
        'valor_sin_iva', 'iva', 'valor_con_iva', 'depto_origen', 'municipio_origen', 'origen_residuos'], ventaRows);

    // 15) Pagos (seguridad social y tarifa) por reciclador
    const conceptoSeguridad = await catalogoMap(client, 'tipos_concepto_pago_seguridad');
    const conceptoTarifa = await catalogoMap(client, 'tipos_concepto_pago_tarifa');
    const pagoSeguridadRows = [];
    const pagoTarifaRows = [];
    recicladorIds.forEach((idReciclador, i) => {
      pagoSeguridadRows.push({
        id_centro: idCentro, id_reciclador: idReciclador, id_tipo_concepto: pick(conceptoSeguridad).id,
        fecha: randomDate(90, 1), planilla: 'PLA-' + pad(i + 1, 5), cantidad: 1, valor: randomInt(80000, 150000)
      });
      pagoTarifaRows.push({
        id_centro: idCentro, id_reciclador: idReciclador, id_tipo_concepto: pick(conceptoTarifa).id,
        fecha: randomDate(90, 1), nro_referencia: 'REF-' + pad(i + 1, 5), cantidad: 1, valor: randomInt(150000, 400000)
      });
    });
    await bulkInsert(client, 'tz_formulario_pago_seguridad',
      ['id_centro', 'id_reciclador', 'id_tipo_concepto', 'fecha', 'planilla', 'cantidad', 'valor'], pagoSeguridadRows);
    await bulkInsert(client, 'tz_formulario_pago_tarifa',
      ['id_centro', 'id_reciclador', 'id_tipo_concepto', 'fecha', 'nro_referencia', 'cantidad', 'valor'], pagoTarifaRows);

    // 16) Balance de masas: la tabla mas extensa, para poder probar filtros, graficas y exportes.
    const materiales = (await client.query('SELECT id FROM tz_tipos_material')).rows.map((r) => r.id);
    const balanceRows = [];
    for (const idReciclador of recicladorIds) {
      const diasConDatos = randomInt(6, 14);
      for (let d = 0; d < diasConDatos; d++) {
        const fecha = randomDate(75, 1);
        const materialesDelDia = randomInt(1, 3);
        for (let m = 0; m < materialesDelDia; m++) {
          const cantidad = randomInt(15, 220);
          balanceRows.push({
            id_centro: idCentro, id_reciclador: idReciclador, id_tipo_material: pick(materiales),
            id_numacro: pick(numacroIds), id_bodega: pick(bodegaIds), id_macrorruta: pick(macrorrutaIds),
            fecha, cantidad, valor: randomInt(200, 1800),
            cantidad_rechazo: Math.random() < 0.2 ? randomInt(1, 10) : 0,
            cantidad_nosui: Math.random() < 0.1 ? randomInt(1, 5) : 0
          });
        }
      }
    }
    await bulkInsert(client, 'tz_formulario_balance_masas',
      ['id_centro', 'id_reciclador', 'id_tipo_material', 'id_numacro', 'id_bodega', 'id_macrorruta',
        'fecha', 'cantidad', 'valor', 'cantidad_rechazo', 'cantidad_nosui'], balanceRows);

    await client.query('COMMIT');

    console.log('Asociacion demo creada: id_centro=' + idCentro);
    console.log('Recicladores: ' + recicladorIds.length);
    console.log('Balance de masas: ' + balanceRows.length + ' filas');
    console.log('Usuarios SUI: ' + usuarioIds.length);
    console.log('Aprovechamiento: ' + aprovechamientoRows.length + ' filas');
    console.log('Listo.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
