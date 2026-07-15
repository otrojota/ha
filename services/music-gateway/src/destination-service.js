import { publicIntegrationConfig } from "./destination-store.js";

export class DestinationService {
  constructor({ store, spotifyConnect, log = () => {} }) {
    this.store = store;
    this.spotifyConnect = spotifyConnect;
    this.log = log;
  }

  getState() {
    const destinations = this.store.listDestinations();
    return {
      integrations: { spotify: publicIntegrationConfig(this.store.getSpotifyIntegration()) },
      activeDestinationId: this.store.getActiveDestination()?.id || null,
      destinations,
      summary: {
        total: destinations.length,
        available: destinations.filter((item) => item.available && item.enabled).length,
        configured: destinations.filter((item) => item.enabled && item.preferredRouteId).length
      }
    };
  }

  async discover() {
    const errors = [];
    let discovered = [];
    try {
      discovered = await this.spotifyConnect.discover();
      await this.store.updateSpotifyAvailability(discovered);
    } catch (error) {
      errors.push({ provider: "spotify", message: error.name === "AbortError" ? "Tiempo de espera agotado" : error.message });
      this.log("warn", "No se pudo descubrir destinos Spotify Connect", { error: error.message });
    }
    return { ...this.getState(), discovered, errors };
  }
}
