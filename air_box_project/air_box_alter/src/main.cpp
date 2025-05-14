#include <Arduino.h>

// put function declarations here:
void showBreathing(int r, int g, int b);
int led_r = 3;
int led_g = 5;
int led_b = 6;
const int measurePin = A5;
const int ledPower = 2;

//set
int samplingTime = 280;
int deltaTime = 40;
int sleepTime = 9680;

//var
float voMeasured = 0;
float calcVoltage = 0;
float dustDensity = 0;
void setup() {
  // put your setup code here, to run once:
  Serial.begin(9600);
  pinMode(led_r, OUTPUT);
  pinMode(led_g, OUTPUT);
  pinMode(led_b, OUTPUT);
  pinMode(ledPower, OUTPUT);

  pinMode(measurePin, INPUT);

  digitalWrite(led_r, LOW);
  digitalWrite(led_g, LOW);
  digitalWrite(led_b, LOW);
}

void loop() {
  // put your main code here, to run repeatedly:
  digitalWrite(ledPower, LOW);
  delayMicroseconds(samplingTime);

  voMeasured = analogRead(measurePin);

  delayMicroseconds(deltaTime);
  digitalWrite(ledPower, HIGH);
  delayMicroseconds(sleepTime);

  calcVoltage = voMeasured * (5.0 / 1024.0);

  if(calcVoltage >= 0.6){
    dustDensity = (170 * calcVoltage -0.1)*0.1;
  }
  else{
    dustDensity = 0;
  }
  delay(1000);
  Serial.println(calcVoltage);
}

void showBreathing(int r, int g, int b){
  int gap = 100;
  for(int i = 1 ; i < gap ; i++){
    analogWrite(led_r, int(r/gap*i));
    analogWrite(led_g, int(g/gap*i));
    analogWrite(led_b, int(b/gap*i));
    delay(10);
  }
  for(int i = gap ; i > 0 ; i--){
    analogWrite(led_r, int(r/gap*i));
    analogWrite(led_g, int(g/gap*i));
    analogWrite(led_b, int(b/gap*i));
    delay(10);
  }
}