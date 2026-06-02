import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConnectionProfiles } from './connection-profiles';

describe('ConnectionProfiles', () => {
  let component: ConnectionProfiles;
  let fixture: ComponentFixture<ConnectionProfiles>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionProfiles],
    }).compileComponents();

    fixture = TestBed.createComponent(ConnectionProfiles);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
