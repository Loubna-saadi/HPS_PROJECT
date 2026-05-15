import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Comparison } from './comparison';

describe('Comparison', () => {
  let component: Comparison;
  let fixture: ComponentFixture<Comparison>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Comparison],
    }).compileComponents();

    fixture = TestBed.createComponent(Comparison);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
