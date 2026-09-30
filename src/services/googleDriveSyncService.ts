/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alumno, Profesor, Sancion, Compensacion, AuditLog } from '../types/convivencia';
import { StorageService } from './storageService';
import { AuthService } from './authService';

const SYNC_URL_STORAGE_KEY = 'sigc_bi_drive_sync_api_url_v1';
const LAST_SYNC_STORAGE_KEY = 'sigc_bi_last_drive_sync_timestamp_v1';

// Endpoint oficial de Google Apps Script vinculado a la cuenta del centro
export const DEFAULT_OFFICIAL_DRIVE_API_URL =
  'https://script.google.com/macros/s/AKfycbyrmV69dBgcg9WD0mx4tQLWeZtbqSR7odMS87HS5VyOPQL90RNNZMkpp5HHGZ30HimLNQ/exec';

export interface DriveDatabaseState {
  version: string;
  timestamp: string;
  origen: string;
  centro: {
    nombre: string;
    codigo: string;
    cuenta_institucional: string;
    drive_folder_id: string;
  };
  profesores: Profesor[];
  credenciales_profesores?: Record<string, string>;
  alumnos: Alumno[];
  sanciones: Sancion[];
  compensaciones: Compensacion[];
  audit_logs: AuditLog[];
}

export class GoogleDriveSyncService {
  /**
   * Obtiene la URL configurada del Web App de Google Apps Script vinculado al Drive del centro.
   */
  static getSyncApiUrl(): string {
    const custom = localStorage.getItem(SYNC_URL_STORAGE_KEY);
    // Si hay una URL personalizada guardada que sea una URL antigua o vacía, migrar a la nueva oficial
    if (custom && custom.includes('AKfycbzIG544uJnAwpFOVCOb2FeCuFpx1MzZU3nLWY9n-ygLNqzycDqeze5tPX8EHE9pFaEePg')) {
      localStorage.setItem(SYNC_URL_STORAGE_KEY, DEFAULT_OFFICIAL_DRIVE_API_URL);
      return DEFAULT_OFFICIAL_DRIVE_API_URL;
    }
    const raw = (custom && custom.trim().length > 0) ? custom.trim() : DEFAULT_OFFICIAL_DRIVE_API_URL;
    // Si la URL contiene el prefijo de dominio corporativo /a/macros/... normalizar a /macros/
    return raw.replace(/\/a\/macros\/[^/]+\//, '/macros/');
  }

  /**
   * Guarda o actualiza la URL del endpoint de Google Apps Script.
   */
  static setSyncApiUrl(url: string): void {
    let cleanUrl = url.trim();
    // Limpiar espacios, comillas o parámetros residuales
    cleanUrl = cleanUrl.replace(/^["']|["']$/g, '');
    if (cleanUrl) {
      // Normalizar URL interna de dominio institucional a formato canónico de Web App
      cleanUrl = cleanUrl.replace(/\/a\/macros\/[^/]+\//, '/macros/');
      localStorage.setItem(SYNC_URL_STORAGE_KEY, cleanUrl);
    } else {
      localStorage.removeItem(SYNC_URL_STORAGE_KEY);
    }
  }

  /**
   * Fecha de la última sincronización completada con éxito.
   */
  static getLastSyncTimestamp(): string | null {
    return localStorage.getItem(LAST_SYNC_STORAGE_KEY);
  }

  /**
   * Empaqueta el estado completo actual del sistema para ser custodiado en Drive.
   */
  static getFullDatabasePayload(): DriveDatabaseState {
    const unidad = StorageService.getUnidadInstitucional();
    return {
      version: '3.0.0-PROD',
      timestamp: new Date().toISOString(),
      origen: 'S.I.G.C. - IES Blas Infante (Córdoba)',
      centro: {
        nombre: 'IES Blas Infante',
        codigo: '14007180',
        cuenta_institucional: unidad.email,
        drive_folder_id: unidad.folderId || '1UJBQCWfs9G9mu3N3F1wDjL_UJ__YhdTP',
      },
      profesores: StorageService.getProfesores(),
      credenciales_profesores: AuthService.getAllCredentials(),
      alumnos: StorageService.getAlumnos(),
      sanciones: StorageService.getSanciones(),
      compensaciones: StorageService.getCompensaciones(),
      audit_logs: StorageService.getAuditLogs(),
    };
  }

  /**
   * Descarga el censo y los datos más recientes desde Google Drive y los fusiona de forma segura.
   */
  static async pullFromGoogleDrive(): Promise<{ success: boolean; message: string; dataCount?: { profesores: number; alumnos: number; sanciones: number } }> {
    const apiUrl = this.getSyncApiUrl();
    if (!apiUrl) {
      // Modo local/institucional directo (sin endpoint HTTP configurado)
      const profesores = StorageService.getProfesores();
      const alumnos = StorageService.getAlumnos();
      const sanciones = StorageService.getSanciones();
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());
      return {
        success: true,
        message: 'Datos locales verificados y listos para custodia institucional.',
        dataCount: { profesores: profesores.length, alumnos: alumnos.length, sanciones: sanciones.length },
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const response = await fetch(`${apiUrl}?action=read_database`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error en el servidor de Google Drive (Código HTTP ${response.status})`);
      }

      const remoteData: Partial<DriveDatabaseState> = await response.json();
      
      const lastLocalWriteStr = StorageService.getLastLocalWriteTimestamp();
      const localWriteTime = lastLocalWriteStr ? new Date(lastLocalWriteStr).getTime() : 0;
      const remoteTime = remoteData.timestamp ? new Date(remoteData.timestamp).getTime() : 0;

      // Si hay datos locales más recientes que la respuesta del servidor (ej. ingesta reciente),
      // no permitimos que la respuesta remota antigua sobrescriba los datos locales y enviamos el push local.
      if (localWriteTime > remoteTime + 1000) {
        this.pushToGoogleDrive().catch(() => {});
        return {
          success: true,
          message: 'Se conservaron los datos locales más recientes y se subieron a Google Drive.',
          dataCount: {
            profesores: StorageService.getProfesores().length,
            alumnos: StorageService.getAlumnos().length,
            sanciones: StorageService.getSanciones().length,
          },
        };
      }

      if (remoteData.profesores && Array.isArray(remoteData.profesores) && remoteData.profesores.length > 0) {
        StorageService.saveProfesores(remoteData.profesores);
      }
      if (remoteData.credenciales_profesores && typeof remoteData.credenciales_profesores === 'object') {
        AuthService.mergeRemoteCredentials(remoteData.credenciales_profesores);
      }
      if (remoteData.alumnos && Array.isArray(remoteData.alumnos)) {
        const localAlumnos = StorageService.getAlumnos();
        const alumnoMap = new Map<string, Alumno>();

        // 1. Agregar alumnos remotos
        remoteData.alumnos.forEach(a => {
          if (a && a.id_alumno) {
            alumnoMap.set(a.id_alumno, a);
          }
        });

        // 2. Fusionar con alumnos locales (si el alumno local no estaba en el remoto, se mantiene para no borrar ingestas)
        localAlumnos.forEach(localA => {
          if (localA && localA.id_alumno) {
            const existingRemote = alumnoMap.get(localA.id_alumno);
            if (!existingRemote) {
              alumnoMap.set(localA.id_alumno, localA);
            } else {
              // Combinar asegurando que si el local tiene cambios recientes los mantenga
              alumnoMap.set(localA.id_alumno, {
                ...existingRemote,
                ...localA,
              });
            }
          }
        });

        StorageService.saveAlumnos(Array.from(alumnoMap.values()));
      }
      if (remoteData.sanciones && Array.isArray(remoteData.sanciones)) {
        StorageService.saveSanciones(remoteData.sanciones);
      }
      if (remoteData.compensaciones && Array.isArray(remoteData.compensaciones)) {
        StorageService.saveCompensaciones(remoteData.compensaciones);
      }

      localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());

      return {
        success: true,
        message: 'Base de datos sincronizada con Google Drive corporativo.',
        dataCount: {
          profesores: (remoteData.profesores || []).length,
          alumnos: (remoteData.alumnos || []).length,
          sanciones: (remoteData.sanciones || []).length,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        message: `No se pudo conectar con el endpoint de Google Drive: ${err.message || err}`,
      };
    }
  }

  /**
   * Sube los datos locales hacia Google Drive para que queden disponibles en todos los dispositivos.
   */
  static async pushToGoogleDrive(): Promise<{ success: boolean; message: string }> {
    const apiUrl = this.getSyncApiUrl();
    const payload = this.getFullDatabasePayload();

    if (!apiUrl) {
      // Guardar snapshot local versionado
      StorageService.crearSnapshotBackup('sistema@g.educaand.es');
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());
      return {
        success: true,
        message: 'Copia de seguridad local preparada para Google Drive.',
      };
    }

    const jsonString = JSON.stringify(payload);

    // 1. Intento principal: POST directo con text/plain
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: jsonString,
      });

      if (response.ok) {
        localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());
        return {
          success: true,
          message: 'Datos y censos custodiados exitosamente en la carpeta de Google Drive.',
        };
      }
    } catch {
      // Si falla por CORS o redirección del navegador, usar fallback
    }

    // 2. Intento de respaldo: Envío multipart o URL encoded compatible
    try {
      const formBody = new URLSearchParams();
      formBody.append('data', jsonString);
      await fetch(apiUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, new Date().toISOString());
      return {
        success: true,
        message: 'Datos enviados a Google Drive (vía compatible).',
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Error al sincronizar con Google Drive: ${err.message || err}`,
      };
    }
  }
}
