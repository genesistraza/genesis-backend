// Archivo plano PILA (Resolución 2388 de 2016, Anexo Técnico 2, "Archivo tipo 2") para el tipo de
// aportante 17 "Pagador Recicladores de Oficio" y el tipo de cotizante 74 "Reciclador de Oficio"
// (Resolución 1529 de 2026): planilla Y, subtipo 0, solo aporta a Riesgos Laborales (clase de riesgo 5),
// IBC = 1 SMLMV por periodos mensuales completos (las novedades son informativas salvo IRL).
//
// Reglas generales del anexo: numericos (N) a la derecha con ceros a la izquierda; alfanumericos (A)
// a la izquierda con espacios a la derecha. Registro tipo 1 = 359 caracteres, registro tipo 2 = 686.
// Redondeo (Decreto 780 de 2016 art. 3.2.1.5, modificado por el Decreto 1990 de 2016): IBC al peso
// superior; cada aporte al multiplo de 100 superior.

const ibcRedondeo = (v) => Math.ceil(Number(v) - 1e-9);
const aporteRedondeo = (v) => Math.ceil(Number(v) / 100 - 1e-9) * 100;

// Quita tildes y caracteres fuera del juego basico (los operadores trabajan en mayusculas ASCII).
function limpiarTexto(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[ñ]/g, 'n').replace(/[Ñ]/g, 'N').toUpperCase().replace(/[^A-Z0-9 .,\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function campo(valor, long, tipo) {
  if (tipo === 'N') {
    // Valor entero (la base devuelve NUMERIC como "1575815.00": nunca concatenar los decimales).
    const n = Number(valor == null || valor === '' ? 0 : valor);
    if (!Number.isFinite(n) || n < 0) throw new Error('Valor numérico inválido: ' + valor);
    const s = String(Math.round(n));
    if (s.length > long) throw new Error('Valor numérico demasiado largo (' + s + ', máx. ' + long + ')');
    return s.padStart(long, '0');
  }
  if (tipo === 'B') return ' '.repeat(long); // campo en blanco (aunque sea N, el anexo indica "blanco")
  if (tipo === 'T') { // tarifa en decimales con punto, p. ej. 0.06960
    const dec = long - 2;
    const s = Number(valor || 0).toFixed(dec);
    if (s.length !== long) throw new Error('Tarifa fuera de formato: ' + s);
    return s;
  }
  const s = String(valor == null ? '' : valor);
  if (s.length > long) throw new Error('Texto demasiado largo para ' + long + ' caracteres: ' + s);
  return s.padEnd(long, ' ');
}
function armar(campos, total) {
  const linea = campos.map(([v, l, t]) => campo(v, l, t)).join('');
  if (linea.length !== total) throw new Error('Registro de ' + linea.length + ' caracteres, se esperaban ' + total);
  return linea;
}
// Partir "PEREZ GOMEZ" -> ["PEREZ", "GOMEZ"]; "JOSE EDUARDO" -> ["JOSE", "EDUARDO"]
function partir(s) {
  const p = limpiarTexto(s).split(' ').filter(Boolean);
  return [p[0] || '', p.slice(1).join(' ')];
}

// Registro tipo 1 (encabezado), 22 campos, 359 caracteres.
function registroTipo1(emp, liq, totalCotizantes) {
  return armar([
    ['01', 2, 'N'],                                       // 1 Tipo de registro
    ['1', 1, 'N'],                                        // 2 Modalidad (1 electronica)
    ['1', 4, 'N'],                                        // 3 Secuencia (0001)
    [limpiarTexto(emp.nombre).slice(0, 200), 200, 'A'],   // 4 Razon social
    ['NI', 2, 'A'],                                       // 5 Tipo documento aportante
    [String(emp.nit), 16, 'A'],                           // 6 Numero identificacion
    [emp.dv || '0', 1, 'N'],                              // 7 DV
    ['Y', 1, 'A'],                                        // 8 Tipo de planilla: Y (independientes empresas)
    ['', 10, 'B'],                                        // 9 Planilla asociada: blanco para Y
    ['', 10, 'A'],                                        // 10 Fecha pago planilla asociada: blanco para Y
    ['U', 1, 'A'],                                        // 11 Forma de presentacion: U (unico)
    ['', 10, 'A'],                                        // 12 Codigo sucursal
    ['', 40, 'A'],                                        // 13 Nombre sucursal
    [emp.codigo_arl || '', 6, 'A'],                       // 14 Codigo ARL del aportante
    [liq.periodo, 7, 'A'],                                // 15 Periodo otros sistemas (Y: igual al 16)
    [liq.periodo, 7, 'A'],                                // 16 Periodo salud
    [0, 10, 'N'],                                         // 17 Numero de radicacion (lo asigna el operador)
    ['', 10, 'A'],                                        // 18 Fecha de pago (la asigna el operador)
    [totalCotizantes, 5, 'N'],                            // 19 Numero total de cotizantes
    [0, 12, 'N'],                                         // 20 Valor total nomina (suma IBC CCF = 0)
    ['17', 2, 'N'],                                       // 21 Tipo de aportante 17
    [0, 2, 'N']                                           // 22 Codigo del operador (lo asigna el operador)
  ], 359);
}

// Registro tipo 2 (liquidacion detallada), 97 campos, 686 caracteres.
function registroTipo2(seq, emp, d, tarifaArl) {
  const [ap1, ap2] = partir(d.apellidos);
  const [no1, no2] = partir(d.nombres);
  const dane = String(d.cod_dane_municipio || emp.cod_dane_municipio || '');
  const tarifa = Number(tarifaArl) / 100; // 6.96 -> 0.0696
  return armar([
    ['02', 2, 'N'],                         // 1 Tipo de registro
    [seq, 5, 'N'],                          // 2 Secuencia
    [d.tipo_doc, 2, 'A'],                   // 3 Tipo documento cotizante
    [d.nro_doc, 16, 'A'],                   // 4 Numero identificacion
    ['74', 2, 'N'],                         // 5 Tipo de cotizante 74 Reciclador de Oficio
    ['0', 2, 'N'],                          // 6 Subtipo 0
    ['', 1, 'A'],                           // 7 Extranjero no obligado a pension
    ['', 1, 'A'],                           // 8 Colombiano en el exterior
    [dane.slice(0, 2), 2, 'A'],             // 9 Departamento (DIVIPOLA)
    [dane.slice(2, 5), 3, 'A'],             // 10 Municipio (DIVIPOLA)
    [ap1.slice(0, 20), 20, 'A'],            // 11 Primer apellido
    [ap2.slice(0, 30), 30, 'A'],            // 12 Segundo apellido
    [no1.slice(0, 20), 20, 'A'],            // 13 Primer nombre
    [no2.slice(0, 30), 30, 'A'],            // 14 Segundo nombre
    [d.nov_ingreso ? 'X' : '', 1, 'A'],     // 15 ING
    [d.nov_retiro ? 'X' : '', 1, 'A'],      // 16 RET
    ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], // 17-20 TDE TAE TDP TAP
    ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], // 21 VSP 22 Correcciones 23 VST 24 SLN
    ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], ['', 1, 'A'], // 25 IGE 26 LMA 27 VAC 28 AVP 29 VCT
    [d.dias_irl, 2, 'N'],                   // 30 IRL: dias de incapacidad laboral
    ['', 6, 'A'], ['', 6, 'A'],             // 31-32 AFP (no aporta a pension)
    ['', 6, 'A'], ['', 6, 'A'],             // 33-34 EPS (no aporta a salud)
    ['', 6, 'A'],                           // 35 CCF (no aporta)
    [0, 2, 'N'], [0, 2, 'N'],               // 36 dias pension, 37 dias salud
    [d.dias_arl, 2, 'N'],                   // 38 dias Riesgos Laborales
    [0, 2, 'N'],                            // 39 dias CCF
    [d.smlmv, 9, 'N'],                      // 40 Salario basico (1 SMLMV)
    ['', 1, 'A'],                           // 41 Tipo de salario (solo dependientes)
    [0, 9, 'N'], [0, 9, 'N'],               // 42 IBC pension, 43 IBC salud
    [d.ibc_arl, 9, 'N'],                    // 44 IBC Riesgos Laborales
    [0, 9, 'N'],                            // 45 IBC CCF
    [0, 7, 'T'],                            // 46 Tarifa pensiones
    [0, 9, 'N'], [0, 9, 'N'], [0, 9, 'N'], [0, 9, 'N'], [0, 9, 'N'], [0, 9, 'N'], [0, 9, 'N'], // 47-53
    [0, 7, 'T'],                            // 54 Tarifa salud
    [0, 9, 'N'], [0, 9, 'N'],               // 55 cotizacion salud, 56 UPC adicional
    ['', 15, 'A'], [0, 9, 'N'],             // 57-58 incapacidad EG
    ['', 15, 'A'], [0, 9, 'N'],             // 59-60 licencia maternidad
    [tarifa, 9, 'T'],                       // 61 Tarifa Riesgos Laborales (clase 5)
    [emp.centro_trabajo || 0, 9, 'N'],      // 62 Centro de trabajo
    [d.aporte_arl, 9, 'N'],                 // 63 Cotizacion obligatoria SGRL
    [0, 7, 'T'], [0, 9, 'N'],               // 64-65 CCF
    [0, 7, 'T'], [0, 9, 'N'],               // 66-67 SENA
    [0, 7, 'T'], [0, 9, 'N'],               // 68-69 ICBF
    [0, 7, 'T'], [0, 9, 'N'],               // 70-71 ESAP
    [0, 7, 'T'], [0, 9, 'N'],               // 72-73 MEN
    ['', 2, 'A'], ['', 16, 'A'],            // 74-75 cotizante principal (solo tipo 40)
    ['N', 1, 'A'],                          // 76 Exonerado Ley 1607
    [emp.codigo_arl || '', 6, 'A'],         // 77 Codigo ARL del afiliado
    ['5', 1, 'A'],                          // 78 Clase de riesgo 5
    ['', 1, 'A'],                           // 79 Indicador tarifa especial pensiones
    [d.nov_ingreso && d.fecha_ingreso ? d.fecha_ingreso : '', 10, 'A'], // 80 Fecha ingreso
    [d.nov_retiro && d.fecha_retiro ? d.fecha_retiro : '', 10, 'A'],    // 81 Fecha retiro
    ['', 10, 'A'],                          // 82 VSP
    ['', 10, 'A'], ['', 10, 'A'],           // 83-84 SLN
    ['', 10, 'A'], ['', 10, 'A'],           // 85-86 IGE
    ['', 10, 'A'], ['', 10, 'A'],           // 87-88 LMA
    ['', 10, 'A'], ['', 10, 'A'],           // 89-90 VAC-LR
    ['', 10, 'A'], ['', 10, 'A'],           // 91-92 VCT
    [d.dias_irl ? d.fecha_inicio_irl || '' : '', 10, 'A'], // 93 Fecha inicio IRL
    [d.dias_irl ? d.fecha_fin_irl || '' : '', 10, 'A'],    // 94 Fecha fin IRL
    [0, 9, 'N'],                            // 95 IBC otros parafiscales
    [0, 3, 'N'],                            // 96 Horas laboradas
    ['', 10, 'A']                           // 97 Fecha radicacion en el exterior
  ], 686);
}

function archivoPila(emp, liq, detalle) {
  const lineas = [registroTipo1(emp, liq, detalle.length)];
  detalle.forEach((d, i) => lineas.push(registroTipo2(i + 1, emp, Object.assign({ smlmv: Math.round(Number(liq.smlmv)) }, d), liq.tarifa_arl)));
  return lineas.join('\r\n') + '\r\n';
}

module.exports = { archivoPila, ibcRedondeo, aporteRedondeo, limpiarTexto, partir };
