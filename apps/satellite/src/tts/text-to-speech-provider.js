export class TextToSpeechProvider {
  constructor(name) {
    this.name = name;
  }

  async listVoices() {
    throw new Error("listVoices no implementado");
  }

  async speak() {
    throw new Error("speak no implementado");
  }
}
