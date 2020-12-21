/* eslint-disable max-len */
import { Config, VehicleAttributes, VehicleState, User, VolvoFeatureBindings, VolvoSensorBindings, VolvoActions, SensorNames } from "./util/types";
import { Service as IService, Characteristic as ICharacteristic, AccessoryConfig, Logger } from "homebridge";
import { HomebridgeAPI, API } from "homebridge/lib/api";
import { getConfig, cbfy, getSensorNames } from "./helpers";
import { Vehicle } from "./util/vehicle";
import { REST } from "./util/rest";

let Service: typeof IService, Characteristic: typeof ICharacteristic;

export default function (homebridge: HomebridgeAPI) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-volvo", "Volvo", VolvoPlatform);
}

class VolvoPlatform {
  // Definite assignment required since callee-thrown errors are not handled by caller/homebridge.
  // If constructor runs without errors, all members will be assigned. :)
  private readonly config!: Config;
  private readonly sensorNames!: SensorNames;
  private readonly rest!: REST;
  private vehicle!: Vehicle;
  private vehicleCount = 0;
  private readonly _BASENAME!: string;
  private AccessoryInformationService;
  private hasFatalError = false; // error flag for homebridge registration

  constructor(private readonly log: Logger, accessoryConfig: AccessoryConfig, private readonly api: API) {
    log.info("Starting homebridge-volvo");
    try {
      this.config = getConfig(accessoryConfig);
      this.sensorNames = getSensorNames( accessoryConfig["sensorNames"] && typeof accessoryConfig["sensorNames"] === "object" ? accessoryConfig.sensorNames : {});
      this.rest = new REST(this.config);
      this._BASENAME = `${this.config.name} `;
      this.vehicle = this.GetVehicleSync();
      const vehicleModel = `${this.vehicle.attr.modelYear} ${this.vehicle.attr.vehicleType}`;
      log.info(
        `Got vehicle ${vehicleModel} with registration number ${this.vehicle.attr.registrationNumber}.`,
      );
      this.AccessoryInformationService = new this.api.hap.Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, "Volvo")
        .setCharacteristic(Characteristic.SerialNumber, this.vehicle.attr.registrationNumber)
        .setCharacteristic(Characteristic.Model, vehicleModel);
      
    } catch (error) {
      this.hasFatalError = true;
      if (error instanceof Error) {
        log.error(`Failed to start homebridge-volvo with ${error.stack || error}`);
      } else {
        log.error(`Failed to start homebridge-volvo. Error: ${error}`);
      }
      log.info("Shutting down homebridge-volvo.");
      this.Shutdown();
    }
  }

  public GetVehicleSync(): Vehicle {
    // First get vehicles associated with user
    const user: User = this.rest.GetSync("customeraccounts");
    this.vehicleCount = user.accountVehicleRelations.length;
    this.log.debug(`Got account for ${user["username"]}`);
    // Get data and instantiate vehicle class for each vehicle
    this.log.debug(`You have ${this.vehicleCount} vehicle(s) associated with your account.`);
    // Then check every vehicle
    for (let i = 0; i < this.vehicleCount; i++) {
      const vehicle = user.accountVehicleRelations[i];
      // Get vehicle URN suffix
      const rel = this.rest.GetSync("", vehicle);
      if (rel["status"] === "Verified") {
        const url = rel["vehicle"] + "/";
        // Get data for vehicle
        const vehicleAttributes: VehicleAttributes = this.rest.GetSync("attributes", url);
        // Check if this is the correct vehicle specified by user
        if (vehicleAttributes.VIN === this.config.VIN || !this.config.VIN) {
          // Remove possibly sensitive or identifying information for debugging and submitting issues
          const attributesRedacted = this.Redact(vehicleAttributes, "vin", "VIN", "registrationNumber");
          this.log.debug(`Vehicle attributes:\n${JSON.stringify(attributesRedacted, null, 2)}`);
          const vehicleState: VehicleState = this.rest.GetSync("status", url);
          this.log.debug(`Vehicle state:\n${JSON.stringify(this.Redact(vehicleState, "theftAlarm"), null, 2)}`);
          return new Vehicle(this.config, url, Characteristic, this.log, vehicleAttributes, vehicleState);
        }
      }
    }
    throw new Error(`No vehicles found matching the VIN number you provided (${this.config.VIN}).`);
  }

  private Redact(obj, ...props) {
    const res = Object.assign({}, obj);
    for (const prop of props) {
      delete res[prop];
      res[prop] = "***REDACTED***";
    }
    return res;
  }

  public getServices() {
    // Check if plugin has any startup errors
    if (this.hasFatalError) {
      return [];
    }

    const services: IService[] = [this.AccessoryInformationService];

    // Feature services

    if (this.vehicle.features[VolvoFeatureBindings.HONK_AND_BLINK]) {
      const honkBlinkService = new Service.Switch(this._BASENAME + this.sensorNames.honkAndBlink, VolvoFeatureBindings.HONK_AND_BLINK);
      honkBlinkService
        .getCharacteristic(Characteristic.On)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.HONK_AND_BLINK)))
        .on("set", cbfy(this.vehicle.SetSensorValue.bind(this.vehicle, VolvoActions.HONK_AND_BLINK, honkBlinkService)));
      // HONK_AND_OR_BLINK ∈ HONK_AND_BLINK
      if (this.vehicle.features[VolvoFeatureBindings.HONK_AND_OR_BLINK]) {
        const blinkService = new Service.Lightbulb(this._BASENAME + this.sensorNames.blink, VolvoFeatureBindings.HONK_AND_OR_BLINK);
        blinkService
          .getCharacteristic(Characteristic.On)
          .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.BLINK)))
          .on("set", cbfy(this.vehicle.SetSensorValue.bind(this.vehicle, VolvoActions.BLINK, blinkService)));
        services.push(blinkService);
      }
      services.push(honkBlinkService);
    }

    if (this.vehicle.features[VolvoFeatureBindings.REMOTE_HEATER]) {
      const heaterService = new Service.Switch(this._BASENAME + this.sensorNames.heater, VolvoFeatureBindings.REMOTE_HEATER);
      heaterService
        .getCharacteristic(Characteristic.On)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.GROUP_HEATER)))
        .on("set", cbfy(this.vehicle.SetSensorValue.bind(this.vehicle, VolvoActions.HEATER, heaterService)));
      services.push(heaterService);
    }

    if (this.vehicle.features[VolvoFeatureBindings.PRECLIMATIZATION]) {
      const heaterService = new Service.Switch(this._BASENAME + this.sensorNames.preclimatization, VolvoFeatureBindings.PRECLIMATIZATION);
      heaterService
        .getCharacteristic(Characteristic.On)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.GROUP_HEATER)))
        .on("set", cbfy(this.vehicle.SetSensorValue.bind(this.vehicle, VolvoActions.PRECLIMATIZATION, heaterService)));
      services.push(heaterService);
    }
    }

    // Sensor services

    if (this.vehicle.features[VolvoFeatureBindings.BATTERY]) {
      const batterySensorService = new Service.BatteryService(this._BASENAME, VolvoSensorBindings.BATTERY_PERCENT);
      batterySensorService
        .getCharacteristic(Characteristic.BatteryLevel)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.BATTERY_PERCENT)));
      batterySensorService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.BATTERY_PERCENT_LOW)));
      batterySensorService
        .getCharacteristic(Characteristic.ChargingState)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.BATTERY_CHARGE_STATUS)));
      services.push(batterySensorService);
    } else {
      const fuelSensorService = new Service.BatteryService(this._BASENAME, VolvoSensorBindings.FUEL_PERCENT);
      fuelSensorService
        .getCharacteristic(Characteristic.BatteryLevel)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.FUEL_PERCENT)));
      fuelSensorService
        .getCharacteristic(Characteristic.ChargingState)
        .on("get", cbfy(async () => Characteristic.ChargingState.NOT_CHARGING)); // fuel tank will never charge, sadly :(
      fuelSensorService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.FUEL_PERCENT_LOW)));
      services.push(fuelSensorService);
    }

    const engineRunningService = new Service.MotionSensor(this._BASENAME + this.sensorNames.movement, VolvoSensorBindings.ENGINE_STATUS);
    engineRunningService
      .getCharacteristic(Characteristic.MotionDetected)
      .on("get", cbfy(this.vehicle.GetSensorValue.bind(this.vehicle, VolvoSensorBindings.ENGINE_STATUS)));
    services.push(engineRunningService);

    if (services.length === 1) {
      // This is a fatal error, so plugin should not return any services
      this.log.error("Could not find any capabilities for your car. Something has gone wrong. Shutting down.");
      this.Shutdown();
      return [];
    } else {
      return services;
    }

  }

  private Shutdown(): void {
    if (this.vehicle) {
      this.vehicle.Shutdown();
    }
  }
}
