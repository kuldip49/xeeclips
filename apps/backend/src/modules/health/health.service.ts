import { Injectable } from "@nestjs/common";

@Injectable()
export class HealthService {
  getHealth() {
    return {
      service: "backend",
      status: "ok",
      timestamp: new Date().toISOString()
    };
  }
}
