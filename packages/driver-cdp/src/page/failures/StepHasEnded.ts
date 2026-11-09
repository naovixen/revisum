// What input throws instead of sending a command once its step has ended: the step has already failed
// with its timeout, and anything sent now would reach the page during the failure's capture or a later
// step, as input the plan never asked for there.
export class StepHasEnded extends Error {
    constructor(method: string) {
        super(`${method} was not sent: its step had ended`);
        this.name = "StepHasEnded";
    }
}
