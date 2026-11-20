// Texto claro de cada accion del registro de actividad (activity_logs), para mostrarle a las personas
// "que hizo" alguien. Lo usan Registro (Actividad de usuarios) y el panel del fundador (Asesores).
const PANTALLA = (d) => (d && d.pantalla ? ' (' + String(d.pantalla).replace(/_/g, ' ') + ')' : '');
const ACCIONES = {
  // Sesion
  inicio_sesion: () => 'Inició sesión',
  inicio_sesion_2fa: () => 'Inició sesión (con verificación en dos pasos)',
  registro_iniciado: () => 'Se registró en la página',
  correo_verificado: () => 'Verificó su correo',
  '2fa_activado': () => 'Activó la verificación en dos pasos',
  '2fa_desactivado': () => 'Desactivó la verificación en dos pasos',
  sesiones_cerradas_todos_los_dispositivos: () => 'Cerró la sesión en todos los dispositivos',
  // Panel de administracion
  asociacion_creada: (d) => 'Creó una asociación' + (d.associationId ? ' (#' + d.associationId + ')' : ''),
  asociacion_editada: (d) => 'Editó una asociación' + (d.associationId ? ' (#' + d.associationId + ')' : ''),
  asociacion_eliminada: () => 'Eliminó una asociación',
  admin_vio_cliente: (d) => 'Abrió el detalle de una asociación' + (d.associationId ? ' (#' + d.associationId + ')' : ''),
  usuario_admin_creado: (d) => 'Creó el usuario ' + ((d.nuevo && d.nuevo.email) || ''),
  asesor_permisos_cambiados: () => 'Cambió los permisos de un asesor',
  usuario_contacto_actualizado: () => 'Corrigió los datos de contacto de un usuario',
  documentos_asociacion_subidos: () => 'Subió documentos de una asociación',
  logo_asociacion_subido: () => 'Subió el logo de una asociación',
  logo_asociacion_eliminado: () => 'Quitó el logo de una asociación',
  mapa_rutas_subido: () => 'Subió el mapa de rutas de una asociación',
  mapa_rutas_eliminado: () => 'Quitó el mapa de rutas de una asociación',
  pago_efectivo_registrado: () => 'Registró un pago en efectivo',
  plan_corregido_manualmente: () => 'Cambió el plan de una asociación',
  plan_removido_manualmente: () => 'Quitó el plan de una asociación',
  recordatorio_manual_enviado: () => 'Envió un recordatorio de pago',
  balance_masas_subido: () => 'Subió un balance de masas (panel)',
  recicladores_subidos: () => 'Subió recicladores (panel)',
  notificaciones_configuradas: () => 'Cambió la configuración de notificaciones',
  pagos_pendientes_limpiados: () => 'Limpió las solicitudes de pago pendientes',
  // Registro (sistema de usuarios)
  sistema_creado: (d) => 'Creó un registro' + PANTALLA(d),
  sistema_editado: (d) => 'Modificó un registro' + PANTALLA(d),
  sistema_eliminado: (d) => 'Borró un registro' + PANTALLA(d),
  pruebas_balance_masas_dia_guardado: (d) => 'Guardó balance de masas del ' + (d.fecha || '') + ' (' + (d.filas || 0) + ' materiales)',
  pruebas_balance_compra_anexada: (d) => 'Anexó una compra del ' + (d.fecha || '') + ' (' + (d.kg || 0) + ' kg)',
  sistema_factura_generada: (d) => 'Generó la factura ' + (d.numero || ''),
  sistema_importado: (d) => 'Importó un archivo de ' + String(d.tipo || '').replace(/_/g, ' ') + ' (' + (d.filas || 0) + ' filas)',
  sistema_cargue_borrado: (d) => 'Borró un cargue de ' + String(d.tipo || '').replace(/_/g, ' ') + ' (' + (d.filas || 0) + ' filas)',
  sistema_documento_guardado: () => 'Subió o actualizó un documento',
  sistema_documento_eliminado: () => 'Quitó un documento',
  sistema_documento_referencia: (d) => 'Subió el documento de referencia ' + (d.nombre || ''),
  sistema_precio_material: (d) => 'Cambió un precio de material a $' + (d.precio != null ? d.precio : ''),
  sistema_password_cambiada: () => 'Cambió su contraseña',
  sistema_trabajador_creado: (d) => 'Creó al trabajador ' + (d.nombre || ''),
  sistema_trabajador_editado: () => 'Modificó un trabajador',
  sistema_trabajador_permisos: (d) => 'Cambió los permisos de un trabajador (' + (d.opciones || 0) + ' opciones)',
  sistema_colaborador_creado: () => 'Creó un usuario',
  sistema_colaborador_editado: () => 'Modificó un usuario',
  sistema_foto_cambiada: () => 'Cambió una foto',
  sistema_catalogo_creado: () => 'Agregó un código a una lista',
  sistema_catalogo_editado: () => 'Modificó un código de una lista',
  sistema_catalogo_eliminado: () => 'Borró un código de una lista',
  sistema_perfil_opciones: () => 'Cambió las opciones de un perfil'
};

function textoAccion(action, details) {
  const fn = ACCIONES[action];
  return fn ? fn(details || {}) : String(action || '').replace(/_/g, ' ');
}

module.exports = { textoAccion };
