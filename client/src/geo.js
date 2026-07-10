/**
 * Ubicación del motorizado para el rastro de auditoría.
 *
 * Nunca lanza ni rechaza: si el navegador no soporta geolocalización, si el
 * motorizado niega el permiso o si no hay señal, resuelve `null` y la entrega
 * sigue su curso. El GPS jamás debe frenar la operación.
 */
export function getPosition({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,   // radio de error en metros
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 15000 },
    );
  });
}
